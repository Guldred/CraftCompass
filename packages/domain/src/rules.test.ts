import { describe, expect, it } from 'vitest';

import { RuleExceptionSchema } from './rules.js';

const exceptionInput = (): Record<string, unknown> => ({
  id: 'EXCEPTION-MUTATION-1',
  reason: 'A reviewed risk is temporarily accepted.',
  owner: 'platform-team',
  scope: 'Mutation MUTANT-1 only.',
  expires_on: '2027-01-01',
  applies_to: {
    artifact_refs: [],
    mutation_ids: ['MUTANT-1'],
  },
  evidence: [
    {
      id: 'EV-EXCEPTION-MUTATION-1',
      type: 'human_decision',
      description: 'The platform team accepted this exact mutation risk.',
      location: 'decisions/mutation-risk.md',
    },
  ],
});

describe('RuleExceptionSchema', () => {
  it('accepts a human decision with an exact mutation selector', () => {
    expect(RuleExceptionSchema.safeParse(exceptionInput()).success).toBe(true);
  });

  it('rejects an empty machine-readable applicability boundary', () => {
    const input = exceptionInput();
    input.applies_to = {
      artifact_refs: [],
      mutation_ids: [],
    };

    const result = RuleExceptionSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['applies_to'] }),
        ]),
      );
    }
  });

  it('still requires human-decision evidence', () => {
    const input = exceptionInput();
    input.evidence = [
      {
        id: 'EV-TOOL',
        type: 'test_result',
        description: 'A tool observed the mutation.',
        location: 'artifacts/mutations.xml',
      },
    ];

    const result = RuleExceptionSchema.safeParse(input);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['evidence'] }),
        ]),
      );
    }
  });
});
