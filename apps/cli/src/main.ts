#!/usr/bin/env node

import { runCli } from './cli.js';
import { readYamlArtifact, serializeYamlArtifact } from './artifact-file.js';
import { loadArtifactInputs } from './artifact-directory.js';
import { FileSystemRepositoryScanner } from '@craftcompass/providers-filesystem';

import {
  checkAgentInstructionsFile,
  installAgentInstructionsFile,
} from './agent-instructions-file.js';
import { readBoundedRepositoryFile } from './safe-local-file.js';

const repositoryScanner = new FileSystemRepositoryScanner();
const exitCode = await runCli(process.argv.slice(2), {
  readArtifact: readYamlArtifact,
  loadArtifacts: loadArtifactInputs,
  scanRepository: (path) => repositoryScanner.scan(path),
  serializeArtifact: serializeYamlArtifact,
  readBytes: async (path, maximumBytes) =>
    (
      await readBoundedRepositoryFile(process.cwd(), path, {
        maxBytes: maximumBytes,
      })
    ).content,
  checkAgentInstructions: checkAgentInstructionsFile,
  installAgentInstructions: installAgentInstructionsFile,
  writeOut: (message) => {
    process.stdout.write(message.endsWith('\n') ? message : `${message}\n`);
  },
  writeError: (message) => {
    process.stderr.write(`${message}\n`);
  },
  now: () => new Date(),
});

process.exitCode = exitCode;
