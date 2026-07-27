import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  readBoundedLocalFile,
  readBoundedRepositoryFile,
  resolveSafeRepositoryTarget,
  SafeLocalFileError,
  type SafeLocalFileErrorCode,
  writeRepositoryTextFileAtomically,
  writeTextFileAtomically,
} from './safe-local-file.js';

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'craftcompass-safe-local-file-'),
  );
  temporaryDirectories.push(directory);
  return directory;
};

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const expectSafeError = async (
  operation: Promise<unknown>,
  code: SafeLocalFileErrorCode,
): Promise<SafeLocalFileError> => {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(SafeLocalFileError);
    expect(error).toEqual(
      expect.objectContaining<Partial<SafeLocalFileError>>({ code }),
    );
    return error as SafeLocalFileError;
  }
  throw new Error(`Expected SafeLocalFileError with code ${code}.`);
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe('readBoundedLocalFile', () => {
  it('returns an exact byte snapshot with a stable SHA-256', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, 'artifact.bin');
    const content = Uint8Array.from([0, 1, 2, 127, 128, 255]);
    await writeFile(filePath, content);

    const snapshot = await readBoundedLocalFile(filePath, {
      maxBytes: content.byteLength,
    });

    expect(snapshot.filePath).toBe(filePath);
    expect(snapshot.byteLength).toBe(content.byteLength);
    expect(snapshot.content).toEqual(content);
    expect(snapshot.sha256).toBe(
      createHash('sha256').update(content).digest('hex'),
    );
    expect(snapshot.identity.size).toBe(content.byteLength);
  });

  it('decodes valid UTF-8 text with fatal decoding', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, 'AGENTS.md');
    await writeFile(filePath, '# Agent guidance\nGrüße 👋\n', 'utf8');

    const snapshot = await readBoundedLocalFile(filePath, {
      maxBytes: 1_024,
      encoding: 'utf8',
    });

    expect(snapshot.content).toBe('# Agent guidance\nGrüße 👋\n');
    expect(snapshot.sha256).toBe(sha256(snapshot.content));
  });

  it('rejects malformed UTF-8 rather than substituting replacement text', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, 'invalid.txt');
    await writeFile(filePath, Uint8Array.from([0xc3, 0x28]));

    await expectSafeError(
      readBoundedLocalFile(filePath, {
        maxBytes: 2,
        encoding: 'utf8',
      }),
      'invalid_utf8',
    );
  });

  it('rejects an oversized file before reading it', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, 'large.txt');
    await writeFile(filePath, '12345', 'utf8');

    await expectSafeError(
      readBoundedLocalFile(filePath, {
        maxBytes: 4,
        encoding: 'utf8',
      }),
      'file_too_large',
    );
  });

  it('supports a zero-byte ceiling only for an empty file', async () => {
    const directory = await createTemporaryDirectory();
    const emptyPath = path.join(directory, 'empty.txt');
    const nonemptyPath = path.join(directory, 'nonempty.txt');
    await writeFile(emptyPath, '');
    await writeFile(nonemptyPath, 'x');

    const empty = await readBoundedLocalFile(emptyPath, {
      maxBytes: 0,
    });

    expect(empty.byteLength).toBe(0);
    await expectSafeError(
      readBoundedLocalFile(nonemptyPath, { maxBytes: 0 }),
      'file_too_large',
    );
  });

  it('refuses a final symbolic link without reading its target', async () => {
    const directory = await createTemporaryDirectory();
    const targetPath = path.join(directory, 'target.txt');
    const linkPath = path.join(directory, 'link.txt');
    await writeFile(targetPath, 'secret', 'utf8');
    await symlink(targetPath, linkPath);

    await expectSafeError(
      readBoundedLocalFile(linkPath, {
        maxBytes: 1_024,
        encoding: 'utf8',
      }),
      'symlink_refused',
    );
  });

  it('refuses directories and other non-regular paths', async () => {
    const directory = await createTemporaryDirectory();

    await expectSafeError(
      readBoundedLocalFile(directory, { maxBytes: 1_024 }),
      'not_a_regular_file',
    );
  });

  it('validates the configurable byte ceiling', async () => {
    const directory = await createTemporaryDirectory();
    const filePath = path.join(directory, 'file.txt');
    await writeFile(filePath, '');

    await expectSafeError(
      readBoundedLocalFile(filePath, { maxBytes: -1 }),
      'invalid_options',
    );
  });
});

describe('resolveSafeRepositoryTarget', () => {
  it('canonicalizes an existing repository root and resolves a regular file', async () => {
    const directory = await createTemporaryDirectory();
    const repository = path.join(directory, 'repository');
    const linkedRepository = path.join(directory, 'repository-link');
    await mkdir(repository);
    await writeFile(path.join(repository, 'AGENTS.md'), '# Owned\n');
    await symlink(repository, linkedRepository);

    const resolved = await resolveSafeRepositoryTarget(
      linkedRepository,
      'AGENTS.md',
    );

    expect(resolved).toBe(path.join(await realpath(repository), 'AGENTS.md'));
  });

  it.each([
    '../AGENTS.md',
    'docs/../../AGENTS.md',
    '/absolute/AGENTS.md',
    'docs\\AGENTS.md',
    'docs//AGENTS.md',
    './AGENTS.md',
    'C:AGENTS.md',
  ])('rejects traversal or ambiguous target %s', async (target) => {
    const repository = await createTemporaryDirectory();

    await expectSafeError(
      resolveSafeRepositoryTarget(repository, target, {
        allowMissing: true,
      }),
      'path_outside_repository',
    );
  });

  it('rejects final and intermediate symbolic-link components', async () => {
    const directory = await createTemporaryDirectory();
    const repository = path.join(directory, 'repository');
    const realDirectory = path.join(repository, 'real');
    await mkdir(realDirectory, { recursive: true });
    await writeFile(path.join(realDirectory, 'AGENTS.md'), '# Real\n');
    await symlink(realDirectory, path.join(repository, 'linked-directory'));
    await symlink(
      path.join(realDirectory, 'AGENTS.md'),
      path.join(repository, 'AGENTS.md'),
    );

    await expectSafeError(
      resolveSafeRepositoryTarget(repository, 'AGENTS.md'),
      'symlink_refused',
    );
    await expectSafeError(
      resolveSafeRepositoryTarget(repository, 'linked-directory/AGENTS.md'),
      'symlink_refused',
    );
    await expectSafeError(
      readBoundedRepositoryFile(repository, 'linked-directory/AGENTS.md', {
        maxBytes: 1_024,
      }),
      'symlink_refused',
    );
  });

  it('allows only a missing final leaf when requested', async () => {
    const repository = await createTemporaryDirectory();
    await mkdir(path.join(repository, 'generated'));

    await expect(
      resolveSafeRepositoryTarget(repository, 'generated/AGENTS.md', {
        allowMissing: true,
      }),
    ).resolves.toBe(
      path.join(await realpath(repository), 'generated', 'AGENTS.md'),
    );
    await expectSafeError(
      resolveSafeRepositoryTarget(repository, 'missing/AGENTS.md', {
        allowMissing: true,
      }),
      'path_not_found',
    );
  });

  it('rejects a directory as the final file target', async () => {
    const repository = await createTemporaryDirectory();
    await mkdir(path.join(repository, 'AGENTS.md'));

    await expectSafeError(
      resolveSafeRepositoryTarget(repository, 'AGENTS.md'),
      'not_a_regular_file',
    );
  });
});

describe('writeTextFileAtomically', () => {
  it('creates a new generated file through an exclusive same-directory temp', async () => {
    const repository = await createTemporaryDirectory();
    const targetPath = path.join(repository, 'AGENTS.md');
    const content = '# Generated by CraftCompass\n';

    const result = await writeRepositoryTextFileAtomically(
      repository,
      'AGENTS.md',
      content,
      { maxBytes: 1_024 },
    );

    expect(result).toEqual({
      filePath: path.join(await realpath(repository), 'AGENTS.md'),
      byteLength: Buffer.byteLength(content),
      sha256: sha256(content),
      replacedExisting: false,
    });
    expect(await readFile(targetPath, 'utf8')).toBe(content);
    expect(
      (await readdir(repository)).filter((name) =>
        name.includes('.craftcompass-'),
      ),
    ).toEqual([]);
  });

  it('never replaces an existing file without explicit authorization', async () => {
    const repository = await createTemporaryDirectory();
    const targetPath = path.join(repository, 'AGENTS.md');
    await writeFile(targetPath, '# Human-owned\n');

    await expectSafeError(
      writeTextFileAtomically(targetPath, '# Generated\n', {
        maxBytes: 1_024,
      }),
      'target_exists',
    );
    expect(await readFile(targetPath, 'utf8')).toBe('# Human-owned\n');
  });

  it('requires both the exact existing hash and a positive ownership predicate', async () => {
    const repository = await createTemporaryDirectory();
    const targetPath = path.join(repository, 'AGENTS.md');
    const existing = '# Generated by CraftCompass\nOld\n';
    await writeFile(targetPath, existing);

    await expectSafeError(
      writeTextFileAtomically(targetPath, 'New\n', {
        maxBytes: 1_024,
        expectedExisting: {
          sha256: sha256('different'),
          isOwned: () => true,
        },
      }),
      'overwrite_precondition_failed',
    );
    await expectSafeError(
      writeTextFileAtomically(targetPath, 'New\n', {
        maxBytes: 1_024,
        expectedExisting: {
          sha256: sha256(existing),
          isOwned: () => false,
        },
      }),
      'ownership_rejected',
    );
    expect(await readFile(targetPath, 'utf8')).toBe(existing);
  });

  it('atomically replaces an authorized generated file and preserves its mode', async () => {
    const repository = await createTemporaryDirectory();
    const targetPath = path.join(repository, 'AGENTS.md');
    const existing = '# Generated by CraftCompass\nOld\n';
    const replacement = '# Generated by CraftCompass\nNew\n';
    await writeFile(targetPath, existing);
    await chmod(targetPath, 0o640);
    let predicateSnapshot: string | undefined;

    const result = await writeTextFileAtomically(targetPath, replacement, {
      maxBytes: 1_024,
      expectedExisting: {
        sha256: sha256(existing),
        isOwned: (snapshot) => {
          predicateSnapshot = snapshot.content;
          return snapshot.content.startsWith('# Generated by CraftCompass\n');
        },
      },
    });

    expect(predicateSnapshot).toBe(existing);
    expect(result.replacedExisting).toBe(true);
    expect(result.sha256).toBe(sha256(replacement));
    expect(await readFile(targetPath, 'utf8')).toBe(replacement);
    expect((await lstat(targetPath)).mode & 0o777).toBe(0o640);
  });

  it('rejects a symbolic-link target and leaves the linked file unchanged', async () => {
    const directory = await createTemporaryDirectory();
    const linkedTarget = path.join(directory, 'human.txt');
    const generatedPath = path.join(directory, 'AGENTS.md');
    await writeFile(linkedTarget, 'Human content\n');
    await symlink(linkedTarget, generatedPath);

    await expectSafeError(
      writeTextFileAtomically(generatedPath, 'Generated content\n', {
        maxBytes: 1_024,
      }),
      'symlink_refused',
    );
    expect(await readFile(linkedTarget, 'utf8')).toBe('Human content\n');
  });

  it('rejects oversized generated text before creating a temporary file', async () => {
    const repository = await createTemporaryDirectory();
    const targetPath = path.join(repository, 'AGENTS.md');

    await expectSafeError(
      writeTextFileAtomically(targetPath, '12345', {
        maxBytes: 4,
      }),
      'file_too_large',
    );
    expect(await readdir(repository)).toEqual([]);
  });

  it('rejects an expected-existing precondition when the target is absent', async () => {
    const repository = await createTemporaryDirectory();
    const targetPath = path.join(repository, 'AGENTS.md');

    await expectSafeError(
      writeTextFileAtomically(targetPath, 'New\n', {
        maxBytes: 1_024,
        expectedExisting: {
          sha256: sha256('Old\n'),
          isOwned: () => true,
        },
      }),
      'overwrite_precondition_failed',
    );
  });

  it('detects a change during authorization and removes its temporary file', async () => {
    const repository = await createTemporaryDirectory();
    const targetPath = path.join(repository, 'AGENTS.md');
    const existing = '# Generated by CraftCompass\nOld\n';
    await writeFile(targetPath, existing);

    await expectSafeError(
      writeTextFileAtomically(targetPath, 'Replacement\n', {
        maxBytes: 1_024,
        expectedExisting: {
          sha256: sha256(existing),
          isOwned: async () => {
            await writeFile(targetPath, 'Concurrent change\n');
            return true;
          },
        },
      }),
      'overwrite_precondition_failed',
    );
    expect(await readFile(targetPath, 'utf8')).toBe('Concurrent change\n');
    expect(
      (await readdir(repository)).filter((name) =>
        name.includes('.craftcompass-'),
      ),
    ).toEqual([]);
  });

  it('rejects text containing an unpaired surrogate', async () => {
    const repository = await createTemporaryDirectory();
    const targetPath = path.join(repository, 'AGENTS.md');

    await expectSafeError(
      writeTextFileAtomically(targetPath, '\ud800', {
        maxBytes: 1_024,
      }),
      'invalid_utf8',
    );
  });
});
