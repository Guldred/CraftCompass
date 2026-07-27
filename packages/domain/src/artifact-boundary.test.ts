import { describe, expect, it } from 'vitest';

import { validateArtifact } from './artifact.js';

const minimalProject = (): Record<string, unknown> => ({
  schema_version: 1,
  kind: 'project_profile',
  id: 'PROJECT-BOUNDARY',
  name: 'Boundary test',
  technologies: [],
  modules: [],
  observations: [
    {
      id: 'OBS-BOUNDARY',
      type: 'fact',
      statement: 'The boundary fixture is intentionally minimal.',
      confidence: 1,
      evidence: [
        {
          id: 'EV-BOUNDARY',
          type: 'test_result',
          description: 'The fixture is exercised by the boundary test.',
          location: 'packages/domain/src/artifact-boundary.test.ts',
        },
      ],
    },
  ],
  constraints: [],
  uncertainties: [],
});

describe('artifact validation boundary', () => {
  it('rejects accessors without evaluating them', () => {
    let evaluated = false;
    const input = minimalProject();
    Object.defineProperty(input, 'name', {
      enumerable: true,
      get: () => {
        evaluated = true;
        return 'unsafe';
      },
    });

    const result = validateArtifact(input, {
      now: new Date('2026-07-27T12:00:00Z'),
    });

    expect(result).toMatchObject({
      success: false,
      issues: [{ code: 'invalid_artifact_input' }],
    });
    expect(evaluated).toBe(false);
  });

  it('returns stable failures for cycles, hostile proxies, and oversized input', () => {
    const cyclic = minimalProject();
    cyclic.self = cyclic;
    expect(
      validateArtifact(cyclic, {
        now: new Date('2026-07-27T12:00:00Z'),
      }),
    ).toMatchObject({
      success: false,
      issues: [{ code: 'invalid_artifact_input' }],
    });

    const hostile = new Proxy(
      {},
      {
        getPrototypeOf: () => {
          throw new Error('hostile trap');
        },
      },
    );
    expect(
      validateArtifact(hostile, {
        now: new Date('2026-07-27T12:00:00Z'),
      }),
    ).toMatchObject({
      success: false,
      issues: [{ code: 'invalid_artifact_input' }],
    });

    const oversized = minimalProject();
    oversized.observations = new Array<unknown>(100_001);
    expect(
      validateArtifact(oversized, {
        now: new Date('2026-07-27T12:00:00Z'),
      }),
    ).toMatchObject({
      success: false,
      issues: [{ code: 'input_limit_exceeded' }],
    });
  });

  it('rejects an invalid injected validation time without throwing', () => {
    expect(
      validateArtifact(minimalProject(), {
        now: new Date(Number.NaN),
      }),
    ).toMatchObject({
      success: false,
      issues: [{ code: 'invalid_validation_time' }],
    });
  });
});
