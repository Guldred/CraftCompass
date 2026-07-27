import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  checkAgentInstructionsFile,
  installAgentInstructionsFile,
} from './agent-instructions-file.js';

const temporaryDirectories: string[] = [];
const managed = (
  project = 'PROJECT-ONE',
  version = 1,
  body = 'Current',
): string =>
  `<!-- craftcompass-managed:agent-instructions version=${version} project=${project} sources=PROFILE-ONE,PROJECT-ONE -->\n\n# CraftCompass agent instructions\n\n${body}\n`;

const temporaryRepository = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'craftcompass-agent-file-'),
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('managed agent-instruction files', () => {
  it('reports a missing target without changing the repository', async () => {
    const repository = await temporaryRepository();

    const result = await checkAgentInstructionsFile(repository, managed());

    expect(result.status).toBe('missing');
    await expect(
      lstat(path.join(repository, 'AGENTS.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a mode-0644 managed file and then remains idempotent', async () => {
    const repository = await temporaryRepository();
    const content = managed();

    const created = await installAgentInstructionsFile(repository, content);
    const unchanged = await installAgentInstructionsFile(repository, content);

    expect(created.status).toBe('created');
    expect(unchanged.status).toBe('unchanged');
    expect(await readFile(created.filePath, 'utf8')).toBe(content);
    expect((await lstat(created.filePath)).mode & 0o777).toBe(0o644);
    expect(await checkAgentInstructionsFile(repository, content)).toMatchObject(
      { status: 'current' },
    );
  });

  it('detects drift and refuses to treat a managed marker as overwrite authority', async () => {
    const repository = await temporaryRepository();
    const existing = managed('PROJECT-ONE', 1, 'Old');
    await writeFile(path.join(repository, 'AGENTS.md'), existing);

    const check = await checkAgentInstructionsFile(repository, managed());

    expect(check.status).toBe('drifted');
    await expect(
      installAgentInstructionsFile(repository, managed()),
    ).rejects.toMatchObject({
      status: 'drifted',
    });
    expect(await readFile(path.join(repository, 'AGENTS.md'), 'utf8')).toBe(
      existing,
    );
  });

  it.each([
    ['human_owned', '# Human instructions\n'],
    ['foreign_project', managed('PROJECT-TWO')],
    ['unsupported_version', managed('PROJECT-ONE', 2)],
  ] as const)('refuses to replace a %s file', async (status, existing) => {
    const repository = await temporaryRepository();
    const filePath = path.join(repository, 'AGENTS.md');
    await writeFile(filePath, existing);

    await expect(
      installAgentInstructionsFile(repository, managed()),
    ).rejects.toMatchObject({ status });
    expect(await readFile(filePath, 'utf8')).toBe(existing);
  });

  it('refuses a symbolic-link AGENTS.md for both check and install', async () => {
    const repository = await temporaryRepository();
    const humanFile = path.join(repository, 'human.md');
    await writeFile(humanFile, '# Human\n');
    await symlink(humanFile, path.join(repository, 'AGENTS.md'));

    await expect(
      checkAgentInstructionsFile(repository, managed()),
    ).rejects.toMatchObject({ code: 'symlink_refused' });
    await expect(
      installAgentInstructionsFile(repository, managed()),
    ).rejects.toMatchObject({ code: 'symlink_refused' });
    expect(await readFile(humanFile, 'utf8')).toBe('# Human\n');
  });

  it('rejects expected content without an authentic managed marker', async () => {
    const repository = await temporaryRepository();

    await expect(
      checkAgentInstructionsFile(repository, '# Not managed\n'),
    ).rejects.toThrow(/valid CraftCompass managed marker/u);
  });
});
