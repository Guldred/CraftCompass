import { createHash } from 'node:crypto';

import { MAX_RENDERED_INSTRUCTION_BYTES } from '@craftcompass/instruction-compiler';

import {
  readBoundedLocalFile,
  resolveSafeRepositoryTarget,
  SafeLocalFileError,
  writeRepositoryTextFileAtomically,
} from './safe-local-file.js';

const TARGET = 'AGENTS.md';
const MARKER_PATTERN =
  /^<!-- craftcompass-managed:agent-instructions version=([1-9]\d*) project=([A-Za-z0-9][A-Za-z0-9._:-]*) sources=([A-Za-z0-9._:-]+(?:,[A-Za-z0-9._:-]+)*) -->$/u;

interface ManagedMarker {
  readonly version: number;
  readonly projectId: string;
}

export type AgentInstructionsCheckStatus =
  | 'current'
  | 'missing'
  | 'drifted'
  | 'human_owned'
  | 'foreign_project'
  | 'unsupported_version';

export interface AgentInstructionsCheck {
  readonly status: AgentInstructionsCheckStatus;
  readonly filePath: string;
  readonly expectedSha256: string;
  readonly actualSha256?: string;
  readonly projectId: string;
  readonly formatVersion: number;
}

export interface AgentInstructionsInstallResult {
  readonly status: 'created' | 'unchanged';
  readonly filePath: string;
  readonly sha256: string;
}

/** Stable refusal raised when an existing AGENTS.md is not ours to replace. */
export class AgentInstructionsFileError extends Error {
  readonly status: Exclude<AgentInstructionsCheckStatus, 'current' | 'missing'>;

  constructor(
    status: Exclude<AgentInstructionsCheckStatus, 'current' | 'missing'>,
    message: string,
  ) {
    super(message);
    this.name = 'AgentInstructionsFileError';
    this.status = status;
  }
}

const markerFor = (content: string): ManagedMarker | undefined => {
  const firstLineEnd = content.indexOf('\n');
  const firstLine =
    firstLineEnd === -1 ? content : content.slice(0, firstLineEnd);
  const match = MARKER_PATTERN.exec(firstLine);
  if (match === null) {
    return undefined;
  }
  const version = Number(match[1]);
  const projectId = match[2];
  if (!Number.isSafeInteger(version) || projectId === undefined) {
    return undefined;
  }
  return { version, projectId };
};

const expectedMarker = (content: string): ManagedMarker => {
  const marker = markerFor(content);
  if (marker === undefined) {
    throw new Error(
      'Expected instructions do not begin with a valid CraftCompass managed marker',
    );
  }
  return marker;
};

const sha256ForText = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

/** Read-only drift and ownership check for a repository-root AGENTS.md. */
export const checkAgentInstructionsFile = async (
  repositoryRoot: string,
  expectedContent: string,
): Promise<AgentInstructionsCheck> => {
  const expected = expectedMarker(expectedContent);
  const expectedSha256 = sha256ForText(expectedContent);
  const filePath = await resolveSafeRepositoryTarget(repositoryRoot, TARGET, {
    allowMissing: true,
  });
  let snapshot;
  try {
    snapshot = await readBoundedLocalFile(filePath, {
      maxBytes: MAX_RENDERED_INSTRUCTION_BYTES,
      encoding: 'utf8',
    });
  } catch (error) {
    if (
      error instanceof SafeLocalFileError &&
      error.code === 'path_not_found'
    ) {
      return {
        status: 'missing',
        filePath,
        expectedSha256,
        projectId: expected.projectId,
        formatVersion: expected.version,
      };
    }
    throw error;
  }
  const actual = markerFor(snapshot.content);
  const common = {
    filePath,
    expectedSha256,
    actualSha256: snapshot.sha256,
    projectId: expected.projectId,
    formatVersion: expected.version,
  };
  if (snapshot.sha256 === expectedSha256) {
    return { status: 'current', ...common };
  }
  if (actual === undefined) {
    return { status: 'human_owned', ...common };
  }
  if (actual.projectId !== expected.projectId) {
    return { status: 'foreign_project', ...common };
  }
  if (actual.version !== expected.version) {
    return { status: 'unsupported_version', ...common };
  }
  return { status: 'drifted', ...common };
};

/**
 * Create the managed repository-root AGENTS.md when no file exists.
 *
 * No existing file is overwritten. A generated marker is diagnostic metadata,
 * not authority to replace content that may have been edited by a human.
 */
export const installAgentInstructionsFile = async (
  repositoryRoot: string,
  expectedContent: string,
): Promise<AgentInstructionsInstallResult> => {
  const check = await checkAgentInstructionsFile(
    repositoryRoot,
    expectedContent,
  );
  if (check.status === 'current') {
    return {
      status: 'unchanged',
      filePath: check.filePath,
      sha256: check.expectedSha256,
    };
  }
  if (check.status !== 'missing') {
    throw new AgentInstructionsFileError(
      check.status,
      `${check.filePath}: refusing to overwrite ${check.status.replaceAll('_', ' ')} AGENTS.md`,
    );
  }

  const write = await writeRepositoryTextFileAtomically(
    repositoryRoot,
    TARGET,
    expectedContent,
    {
      maxBytes: MAX_RENDERED_INSTRUCTION_BYTES,
      mode: 0o644,
    },
  );
  return {
    status: 'created',
    filePath: write.filePath,
    sha256: write.sha256,
  };
};
