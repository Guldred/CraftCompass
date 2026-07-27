import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

interface DoctorCheck {
  readonly id: string;
  readonly status: string;
  readonly code: string;
}

interface DoctorReport {
  readonly ready: boolean;
  readonly package_integrity: boolean;
  readonly package_integrity_verified: boolean;
  readonly source_dirty: boolean | null;
  readonly packaged_source_declared_clean: boolean | null;
  readonly publisher_authenticity_unverified: boolean;
  readonly checks: readonly DoctorCheck[];
}

interface PackageFixture {
  readonly container: string;
  readonly packageRoot: string;
  readonly launcher: string;
  readonly runtime: string;
}

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LAUNCHER_SOURCE = path.join(
  REPOSITORY_ROOT,
  'skills',
  'craftcompass',
  'scripts',
  'craftcompass.mjs',
);
const SKILL_SOURCE = path.join(
  REPOSITORY_ROOT,
  'skills',
  'craftcompass',
  'SKILL.md',
);
const WORKFLOW_REFERENCES = [
  'assessment.md',
  'assurance.md',
  'mutation.md',
].map((name) =>
  path.join(REPOSITORY_ROOT, 'skills', 'craftcompass', 'references', name),
);
const SOURCE_COMMIT = 'a'.repeat(40);
const temporaryDirectories: string[] = [];
const cleanLauncherEnvironment = (): NodeJS.ProcessEnv => {
  const environment = { ...process.env };
  delete environment.DYLD_INSERT_LIBRARIES;
  delete environment.LD_PRELOAD;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  return environment;
};

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

const makeWritableForRemoval = (candidate: string): void => {
  const state = lstatSync(candidate);
  if (state.isSymbolicLink() || !state.isDirectory()) {
    return;
  }
  chmodSync(candidate, 0o700);
  for (const entry of readdirSync(candidate)) {
    makeWritableForRemoval(path.join(candidate, entry));
  }
};

const sealDirectories = (root: string): void => {
  const directories: string[] = [];
  const visit = (directory: string): void => {
    directories.push(directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(path.join(directory, entry.name));
      }
    }
  };
  visit(root);
  for (const directory of directories.reverse()) {
    chmodSync(directory, 0o555);
  }
};

const createPackageFixture = (sourceDirty = false): PackageFixture => {
  const container = mkdtempSync(
    path.join(tmpdir(), 'craftcompass-skill-launcher-'),
  );
  temporaryDirectories.push(container);
  const stage = path.join(container, 'stage');
  const launcher = path.join(stage, 'scripts', 'craftcompass.mjs');
  const runtime = path.join(stage, 'runtime', 'craft.mjs');
  mkdirSync(path.dirname(launcher), { recursive: true });
  mkdirSync(path.dirname(runtime), { recursive: true });
  copyFileSync(LAUNCHER_SOURCE, launcher);
  chmodSync(launcher, 0o555);
  writeFileSync(
    runtime,
    [
      '#!/usr/bin/env node',
      'process.stdout.write(JSON.stringify({',
      '  arguments: process.argv.slice(2),',
      '  cwd: process.cwd(),',
      '}));',
      '',
    ].join('\n'),
    { mode: 0o444 },
  );
  chmodSync(runtime, 0o444);

  const files = [
    {
      path: 'runtime/craft.mjs',
      bytes: readFileSync(runtime).byteLength,
      mode: '0444',
      sha256: sha256(readFileSync(runtime)),
    },
    {
      path: 'scripts/craftcompass.mjs',
      bytes: readFileSync(launcher).byteLength,
      mode: '0555',
      sha256: sha256(readFileSync(launcher)),
    },
  ];
  const manifest = `${JSON.stringify(
    {
      schema_version: 1,
      source_commit: SOURCE_COMMIT,
      source_dirty: sourceDirty,
      files,
    },
    null,
    2,
  )}\n`;
  writeFileSync(path.join(stage, 'install-manifest.json'), manifest, {
    mode: 0o444,
  });
  const packageName = `${SOURCE_COMMIT}-${createHash('sha256')
    .update(manifest)
    .digest('hex')}`;
  const packageRoot = path.join(container, packageName);
  renameSync(stage, packageRoot);
  sealDirectories(packageRoot);
  return {
    container,
    packageRoot,
    launcher: path.join(packageRoot, 'scripts', 'craftcompass.mjs'),
    runtime: path.join(packageRoot, 'runtime', 'craft.mjs'),
  };
};

const runDoctor = (
  fixture: PackageFixture,
  environment: NodeJS.ProcessEnv = cleanLauncherEnvironment(),
): { readonly status: number | null; readonly report: DoctorReport } => {
  const result = spawnSync(process.execPath, [fixture.launcher, 'doctor'], {
    encoding: 'utf8',
    env: environment,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return {
    status: result.status,
    report: JSON.parse(result.stdout) as DoctorReport,
  };
};

const checkCode = (report: DoctorReport, id: string): string | undefined =>
  report.checks.find((check) => check.id === id)?.code;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    makeWritableForRemoval(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('CraftCompass installed-skill launcher', () => {
  it('verifies and runs a clean content-addressed package', () => {
    const fixture = createPackageFixture();

    const doctor = runDoctor(fixture);
    const run = spawnSync(
      process.execPath,
      [fixture.launcher, 'run', 'probe', 'value'],
      {
        cwd: fixture.container,
        encoding: 'utf8',
        env: cleanLauncherEnvironment(),
      },
    );

    expect(doctor.status, JSON.stringify(doctor.report)).toBe(0);
    expect(doctor.report.ready).toBe(true);
    expect(doctor.report.package_integrity).toBe(true);
    expect(doctor.report.package_integrity_verified).toBe(true);
    expect(doctor.report.packaged_source_declared_clean).toBe(true);
    expect(doctor.report.publisher_authenticity_unverified).toBe(true);
    expect(checkCode(doctor.report, 'source_provenance')).toBe(
      'packaged_source_declared_clean',
    );
    expect(checkCode(doctor.report, 'publisher_authenticity')).toBe(
      'publisher_authenticity_unverified',
    );
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      arguments: ['probe', 'value'],
      cwd: realpathSync(fixture.container),
    });
  });

  it('keeps dirty-source provenance separate from package integrity', () => {
    const fixture = createPackageFixture(true);

    const doctor = runDoctor(fixture);

    expect(doctor.status).toBe(1);
    expect(doctor.report.package_integrity).toBe(true);
    expect(doctor.report.package_integrity_verified).toBe(true);
    expect(doctor.report.source_dirty).toBe(true);
    expect(doctor.report.packaged_source_declared_clean).toBe(false);
    expect(doctor.report.publisher_authenticity_unverified).toBe(true);
    expect(checkCode(doctor.report, 'source_provenance')).toBe(
      'packaged_source_declared_dirty',
    );
  });

  it('binds one supported Node launcher for the complete skill workflow', () => {
    const skill = readFileSync(SKILL_SOURCE, 'utf8');
    const workflows = WORKFLOW_REFERENCES.map((reference) =>
      readFileSync(reference, 'utf8'),
    );

    expect(skill).toContain(
      'Bind that path to `<supported-node>`, then bind\n   `<launcher>` exactly to:',
    );
    expect(skill).toContain(
      '<supported-node> <skill-directory>/scripts/craftcompass.mjs',
    );
    expect(skill).toContain(
      'keep the exact `<supported-node>` and\n   `<launcher>` bindings for the rest of this skill run',
    );
    workflows.forEach((workflow) => {
      expect(workflow).toContain(
        'Use the exact `<supported-node>` and `<launcher>` bindings established by\n`SKILL.md` for the entire workflow.',
      );
    });
    expect([skill, ...workflows].join('\n')).not.toContain(
      'node <skill-directory>/scripts/craftcompass.mjs',
    );
  });

  it('refuses a package file with weakened permissions', () => {
    const fixture = createPackageFixture();
    chmodSync(fixture.runtime, 0o644);

    const doctor = runDoctor(fixture);

    expect(doctor.status).toBe(1);
    expect(doctor.report.package_integrity).toBe(false);
    expect(checkCode(doctor.report, 'package_integrity')).toBe(
      'package_integrity_failed',
    );
  });

  it('refuses a symlinked runtime entry', () => {
    const fixture = createPackageFixture();
    const externalRuntime = path.join(fixture.container, 'external.mjs');
    writeFileSync(externalRuntime, 'process.exitCode = 0;\n', { mode: 0o444 });
    chmodSync(path.dirname(fixture.runtime), 0o700);
    unlinkSync(fixture.runtime);
    symlinkSync(externalRuntime, fixture.runtime);
    chmodSync(path.dirname(fixture.runtime), 0o555);

    const doctor = runDoctor(fixture);

    expect(doctor.status).toBe(1);
    expect(doctor.report.package_integrity).toBe(false);
  });

  it('refuses a hard-linked runtime entry', () => {
    const fixture = createPackageFixture();
    const externalRuntime = path.join(fixture.container, 'external.mjs');
    writeFileSync(externalRuntime, readFileSync(fixture.runtime), {
      mode: 0o444,
    });
    chmodSync(path.dirname(fixture.runtime), 0o700);
    unlinkSync(fixture.runtime);
    linkSync(externalRuntime, fixture.runtime);
    chmodSync(path.dirname(fixture.runtime), 0o555);

    const doctor = runDoctor(fixture);

    expect(doctor.status).toBe(1);
    expect(doctor.report.package_integrity).toBe(false);
  });

  it('refuses content that no longer matches the manifest', () => {
    const fixture = createPackageFixture();
    chmodSync(fixture.runtime, 0o600);
    writeFileSync(fixture.runtime, 'process.exitCode = 99;\n');
    chmodSync(fixture.runtime, 0o444);

    const doctor = runDoctor(fixture);

    expect(doctor.status).toBe(1);
    expect(doctor.report.package_integrity).toBe(false);
  });

  it('refuses loader-injecting Node environment variables', () => {
    const fixture = createPackageFixture();

    const doctor = runDoctor(fixture, {
      ...cleanLauncherEnvironment(),
      NODE_OPTIONS: '--no-warnings',
    });

    expect(doctor.status).toBe(1);
    expect(doctor.report.package_integrity).toBe(true);
    expect(checkCode(doctor.report, 'node_environment')).toBe(
      'unsafe_node_environment',
    );
  });
});
