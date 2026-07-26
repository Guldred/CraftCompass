import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  loadArtifactInputs,
  MAX_ARTIFACT_DIRECTORY_DEPTH,
  MAX_ARTIFACT_TRAVERSAL_ENTRIES,
} from './artifact-directory.js';
import { MAX_ARTIFACT_FILE_BYTES, readYamlArtifact } from './artifact-file.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VALIDATION_DATE = new Date('2026-07-26T12:00:00.000Z');

describe('artifact input loading', () => {
  it('recursively loads YAML only and deduplicates overlapping inputs', async () => {
    const principles = path.join(REPOSITORY_ROOT, 'knowledge/principles');
    const dependencyDirection = path.join(
      principles,
      'dependency-direction.yaml',
    );

    const entries = await loadArtifactInputs(
      [dependencyDirection, principles, dependencyDirection],
      VALIDATION_DATE,
    );

    expect(entries.map((entry) => entry.artifact.id)).toEqual([
      'ARCH-DEPENDENCY-DIRECTION-001',
      'ASSURANCE-SEMANTIC-STABILITY-001',
    ]);
  });

  it('rejects multi-document YAML instead of silently ignoring documents', async () => {
    const fixture = path.join(
      REPOSITORY_ROOT,
      'fixtures/invalid/multiple-documents.yaml',
    );

    await expect(readYamlArtifact(fixture)).rejects.toThrow(
      'Expected exactly one YAML document',
    );
  });

  it('rejects directories that contain no YAML artifacts', async () => {
    await expect(
      loadArtifactInputs(
        [path.join(REPOSITORY_ROOT, 'fixtures/repositories/unknown-project')],
        VALIDATION_DATE,
      ),
    ).rejects.toThrow(
      'No .yaml or .yml artifacts were found in the supplied inputs',
    );
  });

  it('preserves actionable domain paths for invalid artifacts', async () => {
    await expect(
      loadArtifactInputs(
        [
          path.join(
            REPOSITORY_ROOT,
            'fixtures/invalid/invalid-confidence.yaml',
          ),
        ],
        VALIDATION_DATE,
      ),
    ).rejects.toThrow(
      '$.observations[0].confidence: Confidence must be at most 1 [too_big]',
    );
  });

  it('refuses explicit non-YAML files and filesystem symlinks', async () => {
    const readme = path.join(REPOSITORY_ROOT, 'README.md');
    await expect(loadArtifactInputs([readme], VALIDATION_DATE)).rejects.toThrow(
      'Artifact input must be a .yaml or .yml file',
    );

    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'craftcompass-artifacts-'),
    );
    const link = path.join(temporaryDirectory, 'principle.yaml');
    try {
      await symlink(
        path.join(
          REPOSITORY_ROOT,
          'knowledge/principles/dependency-direction.yaml',
        ),
        link,
      );

      await expect(loadArtifactInputs([link], VALIDATION_DATE)).rejects.toThrow(
        'Refusing to follow symlink',
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects YAML parser warnings instead of discarding unsupported tags', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'craftcompass-artifacts-'),
    );
    const artifact = path.join(temporaryDirectory, 'tagged.yaml');
    try {
      await writeFile(artifact, 'value: !include ./other.yaml\n', 'utf8');

      await expect(readYamlArtifact(artifact)).rejects.toThrow(
        'Unsupported or ambiguous YAML',
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('rejects oversized artifact files before parsing them', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'craftcompass-artifacts-'),
    );
    const artifact = path.join(temporaryDirectory, 'large.yaml');
    try {
      await writeFile(artifact, 'x'.repeat(MAX_ARTIFACT_FILE_BYTES + 1));

      await expect(readYamlArtifact(artifact)).rejects.toThrow(
        `${MAX_ARTIFACT_FILE_BYTES}-byte limit`,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('reports the first invalid artifact in lexical origin order', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'craftcompass-artifacts-'),
    );
    try {
      await Promise.all([
        writeFile(path.join(temporaryDirectory, 'z.yaml'), 'kind: z\n'),
        writeFile(path.join(temporaryDirectory, 'a.yaml'), 'kind: a\n'),
      ]);

      await expect(
        loadArtifactInputs([temporaryDirectory], VALIDATION_DATE),
      ).rejects.toThrow(`${path.join(temporaryDirectory, 'a.yaml')}:`);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('bounds recursive artifact discovery depth', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'craftcompass-artifacts-'),
    );
    let nested = temporaryDirectory;
    try {
      for (let depth = 0; depth <= MAX_ARTIFACT_DIRECTORY_DEPTH; depth += 1) {
        nested = path.join(nested, `d${depth}`);
      }
      await mkdir(nested, { recursive: true });
      await writeFile(path.join(nested, 'artifact.yaml'), 'kind: ignored\n');

      await expect(
        loadArtifactInputs([temporaryDirectory], VALIDATION_DATE),
      ).rejects.toThrow(
        `Artifact directory depth exceeds ${MAX_ARTIFACT_DIRECTORY_DEPTH}`,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('bounds total traversal work including non-YAML entries', async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'craftcompass-artifacts-'),
    );
    try {
      for (let index = 0; index <= MAX_ARTIFACT_TRAVERSAL_ENTRIES; index += 1) {
        await writeFile(
          path.join(temporaryDirectory, `ignored-${index}.txt`),
          '',
        );
      }

      await expect(
        loadArtifactInputs([temporaryDirectory], VALIDATION_DATE),
      ).rejects.toThrow(
        `Artifact traversal exceeds the ${MAX_ARTIFACT_TRAVERSAL_ENTRIES}-entry limit`,
      );
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
