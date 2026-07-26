#!/usr/bin/env node

import { runCli } from './cli.js';
import { readYamlArtifact, serializeYamlArtifact } from './artifact-file.js';
import { loadArtifactInputs } from './artifact-directory.js';
import { FileSystemRepositoryScanner } from '@craftcompass/providers-filesystem';

const repositoryScanner = new FileSystemRepositoryScanner();
const exitCode = await runCli(process.argv.slice(2), {
  readArtifact: readYamlArtifact,
  loadArtifacts: loadArtifactInputs,
  scanRepository: (path) => repositoryScanner.scan(path),
  serializeArtifact: serializeYamlArtifact,
  writeOut: (message) => {
    process.stdout.write(`${message}\n`);
  },
  writeError: (message) => {
    process.stderr.write(`${message}\n`);
  },
  now: () => new Date(),
});

process.exitCode = exitCode;
