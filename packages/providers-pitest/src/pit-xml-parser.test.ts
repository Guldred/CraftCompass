import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PIT_XML_LIMITS,
  PitXmlImportError,
  parsePitXml,
  type PitXmlImportErrorCode,
} from './pit-xml-parser.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const fixturePath = (
  classification: 'valid' | 'invalid',
  name: string,
): string =>
  path.join(REPOSITORY_ROOT, 'fixtures/pitest', classification, name);

const readFixture = (
  classification: 'valid' | 'invalid',
  name: string,
): Promise<string> => readFile(fixturePath(classification, name), 'utf8');

interface MutationXmlOptions {
  readonly status?: string;
  readonly detected?: string;
  readonly sourceFile?: string;
  readonly mutatedClass?: string;
  readonly mutatedMethod?: string;
  readonly methodDescription?: string;
  readonly lineNumber?: string;
  readonly mutator?: string;
  readonly indexes?: readonly number[];
  readonly blocks?: readonly number[];
  readonly testsRun?: string;
  readonly description?: string;
  readonly testFields?: string;
  readonly extraFields?: string;
}

const mutationXml = (options: MutationXmlOptions = {}): string => {
  const status = options.status ?? 'SURVIVED';
  const detected =
    options.detected ??
    ([
      'KILLED',
      'TIMED_OUT',
      'NON_VIABLE',
      'MEMORY_ERROR',
      'RUN_ERROR',
      'EQUIVALENT',
    ].includes(status)
      ? 'true'
      : 'false');
  const indexes = options.indexes ?? [1];
  const blocks = options.blocks ?? [0];
  return [
    `<mutation detected="${detected}" status="${status}" numberOfTestsRun="${options.testsRun ?? '1'}">`,
    `<sourceFile>${options.sourceFile ?? 'src/main/java/example/Example.java'}</sourceFile>`,
    `<mutatedClass>${options.mutatedClass ?? 'example.Example'}</mutatedClass>`,
    `<mutatedMethod>${options.mutatedMethod ?? 'value'}</mutatedMethod>`,
    `<methodDescription>${options.methodDescription ?? '()I'}</methodDescription>`,
    `<lineNumber>${options.lineNumber ?? '7'}</lineNumber>`,
    `<mutator>${options.mutator ?? 'example.Mutator'}</mutator>`,
    `<indexes>${indexes.map((index) => `<index>${index}</index>`).join('')}</indexes>`,
    `<blocks>${blocks.map((block) => `<block>${block}</block>`).join('')}</blocks>`,
    options.testFields ?? '<killingTest/>',
    options.extraFields ?? '',
    `<description>${options.description ?? 'Changed the return value'}</description>`,
    '</mutation>',
  ].join('');
};

const reportXml = (mutations: readonly string[], partial = false): string =>
  `<?xml version="1.0" encoding="UTF-8"?><mutations partial="${String(
    partial,
  )}">${mutations.join('')}</mutations>`;

const captureImportError = (
  operation: () => unknown,
  code: PitXmlImportErrorCode,
): PitXmlImportError => {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(PitXmlImportError);
    expect(error).toEqual(
      expect.objectContaining<Partial<PitXmlImportError>>({ code }),
    );
    return error as PitXmlImportError;
  }
  throw new Error(`Expected PitXmlImportError with code ${code}.`);
};

describe('parsePitXml', () => {
  it('normalizes every completed PIT status and preserves lossless totals', async () => {
    const xml = await readFixture('valid', 'all-statuses.xml');

    const result = parsePitXml(xml, 'target/pit-reports/mutations.xml');

    expect(result.provider).toBe('pitest');
    expect(result.format).toBe('pitest-xml');
    expect(result.origin).toBe('target/pit-reports/mutations.xml');
    expect(result.partial).toBe(false);
    expect(result.id).toMatch(/^PIT-RUN-SHA256-[0-9a-f]{64}$/u);
    expect(result.totals).toEqual({
      generated: 8,
      killed: 1,
      survived: 1,
      no_coverage: 1,
      timed_out: 1,
      non_viable: 1,
      memory_error: 1,
      run_error: 1,
      equivalent_candidates: 1,
      actionable: 7,
    });
    expect(result.mutations.map((mutation) => mutation.outcome).sort()).toEqual(
      [
        'equivalent_candidate',
        'killed',
        'memory_error',
        'no_coverage',
        'non_viable',
        'run_error',
        'survived',
        'timed_out',
      ],
    );
    expect(result.mutations.map((mutation) => mutation.id)).toEqual(
      [...result.mutations.map((mutation) => mutation.id)].sort(),
    );
    expect(
      result.mutations.every((mutation) =>
        /^PIT-MUTANT-SHA256-[0-9a-f]{64}$/u.test(mutation.id),
      ),
    ).toBe(true);
  });

  it('makes every non-killed result actionable without treating errors as kills', async () => {
    const xml = await readFixture('valid', 'all-statuses.xml');

    const result = parsePitXml(xml, 'pit/mutations.xml');
    const killed = result.mutations.find(
      (mutation) => mutation.outcome === 'killed',
    );
    const actionable = result.mutations.filter(
      (mutation) => mutation.outcome !== 'killed',
    );

    expect(killed?.action).toBeNull();
    expect(actionable).toHaveLength(7);
    expect(
      actionable.map((mutation) => mutation.action.category).sort(),
    ).toEqual([
      'add_test_coverage',
      'investigate_memory_error',
      'investigate_non_viable_mutation',
      'investigate_run_error',
      'investigate_survivor',
      'investigate_timeout',
      'review_equivalent_candidate',
    ]);
  });

  it('keeps PIT EQUIVALENT as an explicitly non-authoritative candidate', async () => {
    const xml = await readFixture('valid', 'all-statuses.xml');

    const equivalent = parsePitXml(xml, 'pit/mutations.xml').mutations.find(
      (mutation) => mutation.pit_status === 'EQUIVALENT',
    );

    expect(equivalent).toEqual(
      expect.objectContaining({
        outcome: 'equivalent_candidate',
        equivalent_classification: {
          value: 'equivalent',
          status: 'candidate',
          authoritative: false,
          asserted_by: 'pitest',
        },
      }),
    );
  });

  it('preserves PIT identity-index order and normalizes test matrices', async () => {
    const xml = await readFixture('valid', 'all-statuses.xml');

    const result = parsePitXml(xml, 'pit/mutations.xml');
    const survivor = result.mutations.find(
      (mutation) => mutation.pit_status === 'SURVIVED',
    );
    const killed = result.mutations.find(
      (mutation) => mutation.pit_status === 'KILLED',
    );

    expect(survivor?.indexes).toEqual([12, 11]);
    expect(
      result.mutations.find((mutation) => mutation.pit_status === 'NO_COVERAGE')
        ?.description,
    ).toBe('Removed call to audit & archive');
    expect(killed?.tests).toEqual({
      mode: 'full',
      killing_tests: [
        'example.OrderServiceTest.shouldApprove',
        'example.OrderServiceTest.shouldReject',
      ],
      succeeding_tests: ['example.OrderServiceTest.shouldIgnoreDraft'],
      covering_tests: [
        'example.OrderServiceTest.shouldApprove',
        'example.OrderServiceTest.shouldIgnoreDraft',
        'example.OrderServiceTest.shouldReject',
      ],
    });
  });

  it('accepts UTF-8 bytes and a zero-mutation partial report', async () => {
    const xml = await readFixture('valid', 'empty-partial.xml');
    const bytes = new TextEncoder().encode(xml);

    const result = parsePitXml(bytes, 'target/pit/empty.xml');

    expect(result.partial).toBe(true);
    expect(result.mutations).toEqual([]);
    expect(result.totals.generated).toBe(0);
    expect(result.id).toMatch(/^PIT-RUN-SHA256-[0-9a-f]{64}$/u);
  });

  it('accepts PIT no-method-context records with line number zero', async () => {
    const xml = await readFixture('valid', 'no-method-context.xml');

    const result = parsePitXml(xml, 'target/pit/no-method-context.xml');

    expect(result.mutations).toHaveLength(1);
    expect(result.mutations[0]?.line).toBe(0);
  });

  it('keeps mutant and run identities stable across record order and descriptions', () => {
    const firstMutation = mutationXml({
      sourceFile: 'Example.java',
      description: 'First wording',
      indexes: [9, 3],
    });
    const secondMutation = mutationXml({
      status: 'KILLED',
      sourceFile: 'Other.java',
      mutatedClass: 'example.Other',
      description: 'Second wording',
      indexes: [4],
      testFields: '<killingTest>example.OtherTest.value</killingTest>',
    });
    const reorderedFirst = mutationXml({
      status: 'KILLED',
      sourceFile: 'Other.java',
      mutatedClass: 'example.Other',
      description: 'Reworded second result',
      indexes: [4],
      testFields: '<killingTest>example.OtherTest.value</killingTest>',
    });
    const reorderedSecond = mutationXml({
      sourceFile: 'Example.java',
      description: 'Reworded first result',
      indexes: [9, 3],
    });

    const first = parsePitXml(
      reportXml([firstMutation, secondMutation]),
      'first/mutations.xml',
    );
    const second = parsePitXml(
      reportXml([reorderedFirst, reorderedSecond]),
      'second/mutations.xml',
    );

    expect(second.id).toBe(first.id);
    expect(second.mutations.map((mutation) => mutation.id)).toEqual(
      first.mutations.map((mutation) => mutation.id),
    );
  });

  it('keeps mutant identity across outcomes while changing the run identity', () => {
    const survivor = parsePitXml(reportXml([mutationXml()]), 'survived.xml');
    const killed = parsePitXml(
      reportXml([
        mutationXml({
          status: 'KILLED',
          testFields: '<killingTest>example.ExampleTest.value</killingTest>',
        }),
      ]),
      'killed.xml',
    );

    expect(killed.mutations[0]?.id).toBe(survivor.mutations[0]?.id);
    expect(killed.id).not.toBe(survivor.id);
  });

  it('keeps semantic identity across source-path, line, and block movement', () => {
    const original = parsePitXml(
      reportXml([
        mutationXml({
          sourceFile: 'src/main/java/example/Before.java',
          lineNumber: '7',
          blocks: [2],
        }),
      ]),
      'before.xml',
    );
    const moved = parsePitXml(
      reportXml([
        mutationXml({
          sourceFile: 'src/main/java/example/After.java',
          lineNumber: '81',
          blocks: [17],
        }),
      ]),
      'after.xml',
    );

    expect(moved.mutations[0]?.id).toBe(original.mutations[0]?.id);
  });

  it.each([
    ['class', { mutatedClass: 'example.Other' }],
    ['method', { mutatedMethod: 'otherValue' }],
    ['descriptor', { methodDescription: '(I)I' }],
    ['mutator', { mutator: 'example.OtherMutator' }],
    ['index', { indexes: [2] }],
    ['index order', { indexes: [2, 1] }],
  ] satisfies readonly [string, MutationXmlOptions][])(
    'changes semantic identity when PIT %s coordinates change',
    (_label, changedCoordinates) => {
      const original = parsePitXml(
        reportXml([mutationXml({ indexes: [1, 2] })]),
        'original.xml',
      );
      const changed = parsePitXml(
        reportXml([
          mutationXml({
            indexes: [1, 2],
            ...changedCoordinates,
          }),
        ]),
        'changed.xml',
      );

      expect(changed.mutations[0]?.id).not.toBe(original.mutations[0]?.id);
    },
  );

  it.each([
    ['unknown-status.xml', 'invalid_record'],
    ['doctype.xml', 'forbidden_xml_construct'],
    ['malformed.xml', 'invalid_xml'],
    ['ambiguous-root.xml', 'invalid_root'],
    ['unsafe-source-path.xml', 'invalid_record'],
    ['duplicate-identity.xml', 'duplicate_mutation'],
    ['duplicate-field.xml', 'invalid_record'],
    ['inconsistent-detected.xml', 'invalid_record'],
    ['mixed-test-matrix.xml', 'invalid_record'],
  ] as const)('rejects invalid fixture %s with %s', async (name, code) => {
    const xml = await readFixture('invalid', name);

    captureImportError(
      () => parsePitXml(xml, `fixtures/pitest/invalid/${name}`),
      code,
    );
  });

  it.each(['NOT_STARTED', 'STARTED', 'FUTURE_STATUS'])(
    'rejects incomplete or unknown PIT status %s',
    (status) => {
      captureImportError(
        () =>
          parsePitXml(
            reportXml([mutationXml({ status, detected: 'false' })]),
            'unknown-status.xml',
          ),
        'invalid_record',
      );
    },
  );

  it.each([
    '/absolute/Example.java',
    '../Example.java',
    'src/../Example.java',
    'src//Example.java',
    'C:\\project\\Example.java',
    'C:project/Example.java',
  ])('rejects unsafe or ambiguous source path %s', (sourceFile) => {
    captureImportError(
      () =>
        parsePitXml(
          reportXml([mutationXml({ sourceFile })]),
          'unsafe-path.xml',
        ),
      'invalid_record',
    );
  });

  it.each(['/absolute.xml', '../outside.xml', 'C:\\pit\\mutations.xml'])(
    'rejects unsafe logical origin %s',
    (origin) => {
      captureImportError(
        () => parsePitXml(reportXml([]), origin),
        'invalid_origin',
      );
    },
  );

  it('rejects malformed UTF-8 bytes', () => {
    captureImportError(
      () => parsePitXml(Uint8Array.from([0xc3, 0x28]), 'pit/mutations.xml'),
      'invalid_encoding',
    );
  });

  it('rejects a non-UTF-8 XML declaration even when passed decoded text', () => {
    captureImportError(
      () =>
        parsePitXml(
          '<?xml version="1.0" encoding="UTF-16"?><mutations partial="false"/>',
          'pit/mutations.xml',
        ),
      'invalid_encoding',
    );
  });

  it('rejects custom entities even without a declaration', () => {
    captureImportError(
      () =>
        parsePitXml(
          reportXml([
            mutationXml({
              description: 'Unsupported &custom; entity',
            }),
          ]),
          'pit/mutations.xml',
        ),
      'invalid_record',
    );
  });

  it('decodes an escaped literal that merely looks like an entity reference', () => {
    const result = parsePitXml(
      reportXml([
        mutationXml({
          description: 'Literal &amp;custom; text',
        }),
      ]),
      'pit/mutations.xml',
    );

    expect(result.mutations[0]?.description).toBe('Literal &custom; text');
  });

  it('rejects processing instructions after the XML declaration', () => {
    captureImportError(
      () =>
        parsePitXml(
          '<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet href="report.xsl"?><mutations partial="false"/>',
          'pit/mutations.xml',
        ),
      'forbidden_xml_construct',
    );
  });

  it('rejects unknown record fields instead of ignoring report drift', () => {
    const error = captureImportError(
      () =>
        parsePitXml(
          reportXml([
            mutationXml({
              extraFields: '<futureField>value</futureField>',
            }),
          ]),
          'pit/mutations.xml',
        ),
      'invalid_record',
    );

    expect(error.message).toContain('futureField');
  });

  it('rejects a killing test attached to a non-killed result', () => {
    captureImportError(
      () =>
        parsePitXml(
          reportXml([
            mutationXml({
              testFields:
                '<killingTest>example.ExampleTest.value</killingTest>',
            }),
          ]),
          'pit/mutations.xml',
        ),
      'invalid_record',
    );
  });

  it.each([
    [
      'killer/success overlap',
      '<killingTests>Test.shared</killingTests><succeedingTests>Test.shared</succeedingTests><coveringTests>Test.shared</coveringTests>',
    ],
    [
      'uncovered classified test',
      '<killingTests>Test.killer</killingTests><succeedingTests>Test.success</succeedingTests><coveringTests>Test.killer</coveringTests>',
    ],
  ])('rejects a contradictory full test matrix: %s', (_label, testFields) => {
    captureImportError(
      () =>
        parsePitXml(
          reportXml([
            mutationXml({
              status: 'KILLED',
              testFields,
            }),
          ]),
          'pit/contradictory-matrix.xml',
        ),
      'invalid_record',
    );
  });

  it('rejects duplicate index values instead of silently de-duplicating', () => {
    captureImportError(
      () =>
        parsePitXml(
          reportXml([mutationXml({ indexes: [1, 1] })]),
          'pit/mutations.xml',
        ),
      'invalid_record',
    );
  });

  it('rejects oversized input before XML decoding', () => {
    const bytes = new Uint8Array(PIT_XML_LIMITS.input_bytes + 1);

    captureImportError(
      () => parsePitXml(bytes, 'pit/oversized.xml'),
      'input_too_large',
    );
  });

  it('rejects an oversized field instead of truncating it', () => {
    const oversizedDescription = 'a'.repeat(
      PIT_XML_LIMITS.description_bytes + 1,
    );

    const error = captureImportError(
      () =>
        parsePitXml(
          reportXml([mutationXml({ description: oversizedDescription })]),
          'pit/oversized-field.xml',
        ),
      'invalid_record',
    );

    expect(error.message).toContain('exceeds');
  });

  it('bounds an entity-heavy field before collecting entity matches', () => {
    const encodedDescription = '&amp;'.repeat(
      Math.floor((PIT_XML_LIMITS.description_bytes * 12) / 5) + 1,
    );

    const error = captureImportError(
      () =>
        parsePitXml(
          reportXml([mutationXml({ description: encodedDescription })]),
          'pit/entity-heavy-field.xml',
        ),
      'invalid_record',
    );

    expect(error.message).toContain('bounded encoded representation');
  });

  it.each(['\u009b', '\u202e'])(
    'rejects unsafe control or formatting character U+%s in source labels',
    (character) => {
      captureImportError(
        () =>
          parsePitXml(
            reportXml([
              mutationXml({
                sourceFile: `Example${character}.java`,
              }),
            ]),
            'pit/unsafe-source-character.xml',
          ),
        'invalid_record',
      );
    },
  );

  it('rejects too many indexes instead of truncating the identity', () => {
    const indexes = Array.from(
      { length: PIT_XML_LIMITS.indexes_per_mutation + 1 },
      (_, index) => index,
    );

    captureImportError(
      () =>
        parsePitXml(
          reportXml([mutationXml({ indexes })]),
          'pit/too-many-indexes.xml',
        ),
      'invalid_record',
    );
  });

  it('rejects too many mutation records before building the XML object graph', () => {
    const excessRecords = '<mutation/>'.repeat(
      PIT_XML_LIMITS.mutation_records + 1,
    );

    captureImportError(
      () =>
        parsePitXml(
          `<mutations partial="false">${excessRecords}</mutations>`,
          'pit/too-many-records.xml',
        ),
      'record_limit_exceeded',
    );
  });

  it('does not count mutation-looking text inside XML comments', () => {
    const comment = '<mutation/>'.repeat(PIT_XML_LIMITS.mutation_records + 1);

    const result = parsePitXml(
      `<mutations partial="false"><!--${comment}--></mutations>`,
      'pit/comment.xml',
    );

    expect(result.totals.generated).toBe(0);
  });

  it('rejects excessive XML nesting before building the object graph', () => {
    const depth = PIT_XML_LIMITS.xml_nesting_depth + 1;
    const nested = `${'<level>'.repeat(depth)}${'</level>'.repeat(depth)}`;

    captureImportError(
      () =>
        parsePitXml(
          `<mutations partial="false">${nested}</mutations>`,
          'pit/deeply-nested.xml',
        ),
      'structure_limit_exceeded',
    );
  });
});
