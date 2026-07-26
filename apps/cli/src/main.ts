#!/usr/bin/env node

import { runCli } from './cli.js';
import { readYamlArtifact } from './artifact-file.js';

const exitCode = await runCli(process.argv.slice(2), {
  readArtifact: readYamlArtifact,
  writeOut: (message) => {
    process.stdout.write(`${message}\n`);
  },
  writeError: (message) => {
    process.stderr.write(`${message}\n`);
  },
  now: () => new Date(),
});

process.exitCode = exitCode;
