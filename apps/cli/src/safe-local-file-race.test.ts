import * as actualFileSystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      actualFileSystem.rm(directory, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe('repository-target atomic write races', () => {
  it('refuses a repository-root swap before a create-only install', async () => {
    const directory = await actualFileSystem.mkdtemp(
      path.join(tmpdir(), 'craftcompass-safe-local-race-'),
    );
    temporaryDirectories.push(directory);
    const repository = path.join(directory, 'repository');
    const movedRepository = path.join(directory, 'moved-repository');
    const outside = path.join(directory, 'outside');
    await actualFileSystem.mkdir(repository);
    await actualFileSystem.mkdir(outside);

    let realpathCalls = 0;
    const racedRealpath = vi.fn(async (candidate: string): Promise<string> => {
      realpathCalls += 1;
      if (realpathCalls === 2) {
        await actualFileSystem.rename(repository, movedRepository);
        await actualFileSystem.symlink(outside, repository);
      }
      return actualFileSystem.realpath(candidate);
    });

    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      ...actualFileSystem,
      realpath: racedRealpath,
    }));
    const { writeRepositoryTextFileAtomically } =
      await import('./safe-local-file.js');

    await expect(
      writeRepositoryTextFileAtomically(
        repository,
        'AGENTS.md',
        '# Generated\n',
        { maxBytes: 1_024 },
      ),
    ).rejects.toMatchObject({
      code: 'overwrite_precondition_failed',
    });
    await expect(
      actualFileSystem.readFile(path.join(outside, 'AGENTS.md'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(actualFileSystem.readdir(movedRepository)).resolves.toEqual(
      [],
    );
    expect(racedRealpath).toHaveBeenCalledTimes(2);
  });
});
