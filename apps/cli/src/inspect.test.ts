import {
  ProjectProfileSchema,
  type ProjectProfile,
} from '@craftcompass/domain';
import { describe, expect, it } from 'vitest';

import { inspectArtifact } from './inspect.js';

const evidence = {
  id: 'EV-REPOSITORY-ROOT',
  type: 'source_file' as const,
  description: 'The repository root was observed.',
  location: '.',
};

const projectProfile = (): ProjectProfile =>
  ProjectProfileSchema.parse({
    schema_version: 1,
    kind: 'project_profile',
    id: 'PROJECT-INSPECTION',
    name: 'inspection-fixture',
    technologies: [],
    modules: [],
    observations: [
      {
        id: 'OBS-REPOSITORY-ROOT',
        type: 'fact',
        statement: 'The repository root was observed.',
        confidence: 1,
        evidence: [evidence],
      },
    ],
    constraints: [],
    uncertainties: [],
  });

describe('artifact inspection', () => {
  it('reports missing project observation coverage as unknown', () => {
    expect(inspectArtifact(projectProfile())).toContain(
      'Observation coverage: unknown',
    );
  });

  it('reports scoped coverage and its provider', () => {
    const profile = projectProfile();
    profile.observation_coverage = {
      status: 'partial',
      provider: {
        id: 'filesystem_repository_scanner',
        contract_version: '1',
      },
      capabilities: [
        {
          id: 'bounded_manifest_observation',
          status: 'partial',
        },
      ],
      inputs: [
        {
          path: '.',
          kind: 'directory',
          status: 'observed',
          evidence: [evidence],
        },
      ],
      limitations: ['Observation is intentionally bounded.'],
    };

    expect(inspectArtifact(profile)).toContain(
      'Observation coverage: partial; provider: filesystem_repository_scanner',
    );
  });
});
