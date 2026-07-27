import { createHash } from 'node:crypto';

import { XMLParser } from 'fast-xml-parser';
import { SyntaxValidator } from 'fast-xml-validator';

import { registerParsedPitRun } from './pit-run-provenance.js';
import type {
  PitActionableMutation,
  PitEquivalentCandidate,
  PitKilledMutation,
  PitMutation,
  PitMutationAction,
  PitMutationOutcome,
  PitMutationRun,
  PitMutationTotals,
  PitTestMatrix,
} from './types.js';

/** Resource ceilings applied before or while materializing a report. */
export const PIT_XML_LIMITS = Object.freeze({
  input_bytes: 32 * 1024 * 1024,
  mutation_records: 10_000,
  xml_elements: 200_000,
  xml_nesting_depth: 32,
  indexes_per_mutation: 256,
  blocks_per_mutation: 256,
  origin_bytes: 2_048,
  source_file_bytes: 4_096,
  class_bytes: 4_096,
  method_bytes: 2_048,
  method_descriptor_bytes: 16_384,
  mutator_bytes: 4_096,
  description_bytes: 65_536,
  test_name_bytes: 8_192,
  test_list_bytes: 262_144,
});

export type PitXmlImportErrorCode =
  | 'input_too_large'
  | 'invalid_origin'
  | 'invalid_encoding'
  | 'forbidden_xml_construct'
  | 'invalid_xml'
  | 'record_limit_exceeded'
  | 'structure_limit_exceeded'
  | 'invalid_root'
  | 'invalid_record'
  | 'duplicate_mutation';

/** Expected, caller-actionable rejection of unsafe or ambiguous PIT XML. */
export class PitXmlImportError extends Error {
  readonly code: PitXmlImportErrorCode;
  readonly origin: string;

  constructor(
    code: PitXmlImportErrorCode,
    message: string,
    origin: string,
    options?: ErrorOptions,
  ) {
    super(`${origin}: ${message}`, options);
    this.name = 'PitXmlImportError';
    this.code = code;
    this.origin = origin;
  }
}

type XmlRecord = Record<string, unknown>;

type PitStatus = PitMutation['pit_status'];

interface KilledStatusDefinition {
  readonly outcome: 'killed';
  readonly detected: boolean;
  readonly action: null;
}

interface ActionableStatusDefinition {
  readonly outcome: Exclude<PitMutationOutcome, 'killed'>;
  readonly detected: boolean;
  readonly action: PitMutationAction;
}

type StatusDefinition = KilledStatusDefinition | ActionableStatusDefinition;

const STATUS_DEFINITIONS: Readonly<Record<PitStatus, StatusDefinition>> = {
  KILLED: {
    outcome: 'killed',
    detected: true,
    action: null,
  },
  SURVIVED: {
    outcome: 'survived',
    detected: false,
    action: {
      required: true,
      category: 'investigate_survivor',
      reason:
        'The relevant tests did not distinguish this mutation from the original behavior.',
    },
  },
  NO_COVERAGE: {
    outcome: 'no_coverage',
    detected: false,
    action: {
      required: true,
      category: 'add_test_coverage',
      reason: 'No test exercised the mutated code.',
    },
  },
  TIMED_OUT: {
    outcome: 'timed_out',
    detected: true,
    action: {
      required: true,
      category: 'investigate_timeout',
      reason:
        'The mutation timed out and therefore needs diagnosis rather than being treated as a test kill.',
    },
  },
  NON_VIABLE: {
    outcome: 'non_viable',
    detected: true,
    action: {
      required: true,
      category: 'investigate_non_viable_mutation',
      reason:
        'PIT could not load the mutation into the JVM; the result needs investigation.',
    },
  },
  MEMORY_ERROR: {
    outcome: 'memory_error',
    detected: true,
    action: {
      required: true,
      category: 'investigate_memory_error',
      reason:
        'The mutation run exhausted memory; the result is not reliable without investigation.',
    },
  },
  RUN_ERROR: {
    outcome: 'run_error',
    detected: true,
    action: {
      required: true,
      category: 'investigate_run_error',
      reason:
        'PIT reported an execution error; the mutation result needs investigation.',
    },
  },
  EQUIVALENT: {
    outcome: 'equivalent_candidate',
    detected: true,
    action: {
      required: true,
      category: 'review_equivalent_candidate',
      reason:
        'PIT marked the mutation equivalent, but this remains a non-authoritative candidate for human review.',
    },
  },
};

const EQUIVALENT_CANDIDATE: PitEquivalentCandidate = {
  value: 'equivalent',
  status: 'candidate',
  authoritative: false,
  asserted_by: 'pitest',
};

const ROOT_KEYS = new Set(['@_partial', 'mutation']);
const MUTATION_KEYS = new Set([
  '@_detected',
  '@_status',
  '@_numberOfTestsRun',
  'sourceFile',
  'mutatedClass',
  'mutatedMethod',
  'methodDescription',
  'lineNumber',
  'mutator',
  'indexes',
  'blocks',
  'killingTest',
  'killingTests',
  'succeedingTests',
  'coveringTests',
  'description',
]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  allowBooleanAttributes: false,
  ignoreDeclaration: true,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
  trimValues: true,
  isArray: (_tagName, jPath, _isLeafNode, isAttribute): boolean =>
    !isAttribute && String(jPath) !== 'mutations',
});

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isRecord = (value: unknown): value is XmlRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const fail = (
  code: PitXmlImportErrorCode,
  message: string,
  origin: string,
  options?: ErrorOptions,
): never => {
  throw new PitXmlImportError(code, message, origin, options);
};

const utf8Length = (value: string): number => Buffer.byteLength(value, 'utf8');

const hasControlCharacter = (
  value: string,
  allowXmlWhitespace: boolean,
): boolean => {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029 ||
      /\p{Cf}/u.test(character) ||
      (codePoint < 0x20 &&
        (!allowXmlWhitespace ||
          (codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)))
    ) {
      return true;
    }
  }
  return false;
};

const normalizeSafeRelativePath = (
  value: string,
  field: string,
  maxBytes: number,
  origin: string,
  code: PitXmlImportErrorCode,
): string => {
  const normalized = value.normalize('NFC').trim().replaceAll('\\', '/');
  if (normalized.length === 0) {
    return fail(code, `${field} must not be empty.`, origin);
  }
  if (utf8Length(normalized) > maxBytes) {
    return fail(code, `${field} exceeds ${maxBytes} UTF-8 bytes.`, origin);
  }
  if (hasControlCharacter(normalized, false)) {
    return fail(code, `${field} contains a control character.`, origin);
  }
  if (normalized.startsWith('/') || /^[A-Za-z]:/u.test(normalized)) {
    return fail(code, `${field} must be a relative path.`, origin);
  }
  const segments = normalized.split('/');
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    )
  ) {
    return fail(
      code,
      `${field} must not contain empty, current-directory, or parent-directory segments.`,
      origin,
    );
  }
  return normalized;
};

const normalizeOrigin = (origin: string): string =>
  normalizeSafeRelativePath(
    origin,
    'Logical origin',
    PIT_XML_LIMITS.origin_bytes,
    '<logical-origin>',
    'invalid_origin',
  );

const decodeInput = (input: string | Uint8Array, origin: string): string => {
  const inputBytes =
    typeof input === 'string' ? utf8Length(input) : input.byteLength;
  if (inputBytes > PIT_XML_LIMITS.input_bytes) {
    return fail(
      'input_too_large',
      `PIT XML exceeds ${PIT_XML_LIMITS.input_bytes} bytes.`,
      origin,
    );
  }
  if (typeof input === 'string') {
    return input.startsWith('\uFEFF') ? input.slice(1) : input;
  }
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(input);
  } catch (error) {
    return fail(
      'invalid_encoding',
      'PIT XML bytes must be valid UTF-8.',
      origin,
      { cause: error },
    );
  }
};

const enforceXmlStructureLimits = (source: string, origin: string): void => {
  let cursor = 0;
  let depth = 0;
  let elements = 0;
  let mutationRecords = 0;
  while (cursor < source.length) {
    const start = source.indexOf('<', cursor);
    if (start === -1) {
      return;
    }
    if (source.startsWith('<!--', start)) {
      const commentEnd = source.indexOf('-->', start + 4);
      cursor = commentEnd === -1 ? source.length : commentEnd + 3;
      continue;
    }
    if (source.startsWith('<?', start)) {
      const instructionEnd = source.indexOf('?>', start + 2);
      cursor = instructionEnd === -1 ? source.length : instructionEnd + 2;
      continue;
    }

    let quote: '"' | "'" | undefined;
    let end = start + 1;
    for (; end < source.length; end += 1) {
      const character = source[end];
      if (quote !== undefined) {
        if (character === quote) {
          quote = undefined;
        }
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '>') {
        break;
      }
    }
    if (end >= source.length) {
      return;
    }

    const tag = source.slice(start + 1, end).trim();
    if (tag.startsWith('/')) {
      depth -= 1;
    } else if (!tag.startsWith('!')) {
      elements += 1;
      if (elements > PIT_XML_LIMITS.xml_elements) {
        fail(
          'structure_limit_exceeded',
          `PIT XML contains more than ${PIT_XML_LIMITS.xml_elements} elements.`,
          origin,
        );
      }
      if (!tag.endsWith('/')) {
        depth += 1;
        if (depth > PIT_XML_LIMITS.xml_nesting_depth) {
          fail(
            'structure_limit_exceeded',
            `PIT XML nesting exceeds ${PIT_XML_LIMITS.xml_nesting_depth} elements.`,
            origin,
          );
        }
      }
      const nameEnd = tag.search(/[\s/]/u);
      const tagName = nameEnd === -1 ? tag : tag.slice(0, nameEnd);
      if (tagName === 'mutation') {
        mutationRecords += 1;
        if (mutationRecords > PIT_XML_LIMITS.mutation_records) {
          fail(
            'record_limit_exceeded',
            `PIT XML contains more than ${PIT_XML_LIMITS.mutation_records} mutation records.`,
            origin,
          );
        }
      }
    }
    cursor = end + 1;
  }
};

const validateXmlEnvelope = (source: string, origin: string): void => {
  if (/<!DOCTYPE\b/iu.test(source) || /<!ENTITY\b/iu.test(source)) {
    fail(
      'forbidden_xml_construct',
      'PIT XML must not contain DOCTYPE or ENTITY declarations.',
      origin,
    );
  }
  const declaration = /^\s*<\?xml\s+([^?]+)\?>/iu.exec(source);
  if (declaration !== null) {
    const encoding = /\bencoding\s*=\s*(['"])([^'"]+)\1/iu.exec(
      declaration[1] ?? '',
    )?.[2];
    if (encoding !== undefined && encoding.toUpperCase() !== 'UTF-8') {
      fail(
        'invalid_encoding',
        `PIT XML declares unsupported encoding ${encoding}; UTF-8 is required.`,
        origin,
      );
    }
  }
  const sourceWithoutDeclaration =
    declaration === null ? source : source.slice(declaration[0].length);
  if (/<\?/u.test(sourceWithoutDeclaration)) {
    fail(
      'forbidden_xml_construct',
      'PIT XML must not contain processing instructions.',
      origin,
    );
  }
  if (/<!\[CDATA\[/iu.test(source)) {
    fail(
      'forbidden_xml_construct',
      'PIT XML must use escaped text rather than CDATA.',
      origin,
    );
  }
  enforceXmlStructureLimits(source, origin);

  let validation;
  try {
    validation = SyntaxValidator.validate(source, {
      docType: {
        maxEntityCount: 0,
        maxEntitySize: 0,
      },
      invalidCharSequence: {
        attrLt: true,
        comment: true,
        tagValue: true,
      },
    });
  } catch (error) {
    fail('invalid_xml', 'PIT XML validation failed.', origin, {
      cause: error,
    });
  }
  if (validation !== true) {
    const validationError = validation?.err;
    if (validationError === undefined) {
      throw new PitXmlImportError(
        'invalid_xml',
        'PIT XML validation returned no result.',
        origin,
      );
    }
    fail(
      'invalid_xml',
      `PIT XML is malformed at line ${validationError.line}, column ${validationError.col}.`,
      origin,
    );
  }
};

const parseXml = (source: string, origin: string): XmlRecord => {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(source);
  } catch (error) {
    return fail('invalid_xml', 'PIT XML could not be decoded.', origin, {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    return fail(
      'invalid_root',
      'PIT XML must contain one root element.',
      origin,
    );
  }
  const topLevelKeys = Object.keys(parsed);
  if (
    topLevelKeys.length !== 1 ||
    topLevelKeys[0] !== 'mutations' ||
    !isRecord(parsed.mutations)
  ) {
    return fail(
      'invalid_root',
      'PIT XML must contain exactly one mutations root element.',
      origin,
    );
  }
  return parsed.mutations;
};

const assertOnlyKeys = (
  record: XmlRecord,
  allowed: ReadonlySet<string>,
  context: string,
  origin: string,
  code: PitXmlImportErrorCode,
): void => {
  const unknownKeys = Object.keys(record)
    .filter((key) => !allowed.has(key))
    .sort(compareText);
  if (unknownKeys.length > 0) {
    fail(
      code,
      `${context} contains unsupported field(s): ${unknownKeys.join(', ')}.`,
      origin,
    );
  }
};

const readAttribute = (
  record: XmlRecord,
  key: string,
  context: string,
  origin: string,
): string => {
  const value = record[`@_${key}`];
  if (typeof value !== 'string' || value.length === 0) {
    return fail(
      context === 'mutations root' ? 'invalid_root' : 'invalid_record',
      `${context} requires exactly one ${key} attribute.`,
      origin,
    );
  }
  return value;
};

const decodeXmlText = (
  value: string,
  field: string,
  origin: string,
): string => {
  const namedEntity = /&([A-Za-z_:][\w.:-]*);/gu;
  let match = namedEntity.exec(value);
  while (match !== null) {
    if (!['lt', 'gt', 'amp', 'apos', 'quot'].includes(match[1] ?? '')) {
      return fail(
        'invalid_record',
        `${field} contains an unsupported entity reference.`,
        origin,
      );
    }
    match = namedEntity.exec(value);
  }
  const decoded = value.replace(
    /&(?:lt|gt|amp|apos|quot|#\d+|#x[0-9A-Fa-f]+);/gu,
    (entity) => {
      switch (entity) {
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        case '&amp;':
          return '&';
        case '&apos;':
          return "'";
        case '&quot;':
          return '"';
        default: {
          const hexadecimal = entity.startsWith('&#x');
          const digits = entity.slice(hexadecimal ? 3 : 2, -1);
          const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10);
          if (
            !Number.isSafeInteger(codePoint) ||
            codePoint <= 0 ||
            codePoint > 0x10ffff ||
            (codePoint >= 0xd800 && codePoint <= 0xdfff)
          ) {
            return fail(
              'invalid_record',
              `${field} contains an invalid character reference.`,
              origin,
            );
          }
          return String.fromCodePoint(codePoint);
        }
      }
    },
  );
  return decoded;
};

const normalizeText = (
  raw: unknown,
  field: string,
  maxBytes: number,
  origin: string,
  allowEmpty = false,
): string => {
  if (typeof raw !== 'string') {
    return fail(
      'invalid_record',
      `${field} must contain plain text without attributes or nested elements.`,
      origin,
    );
  }
  const rawByteLimit = Math.min(PIT_XML_LIMITS.input_bytes, maxBytes * 12);
  if (utf8Length(raw) > rawByteLimit) {
    return fail(
      'invalid_record',
      `${field} exceeds its bounded encoded representation.`,
      origin,
    );
  }
  const value = decodeXmlText(raw, field, origin).normalize('NFC').trim();
  if (!allowEmpty && value.length === 0) {
    return fail('invalid_record', `${field} must not be empty.`, origin);
  }
  if (utf8Length(value) > maxBytes) {
    return fail(
      'invalid_record',
      `${field} exceeds ${maxBytes} UTF-8 bytes.`,
      origin,
    );
  }
  if (hasControlCharacter(value, true)) {
    return fail(
      'invalid_record',
      `${field} contains a control character.`,
      origin,
    );
  }
  return value;
};

const readSingleElement = (
  record: XmlRecord,
  key: string,
  context: string,
  maxBytes: number,
  origin: string,
  allowEmpty = false,
): string => {
  const values = record[key];
  if (!Array.isArray(values) || values.length !== 1) {
    return fail(
      'invalid_record',
      `${context} requires exactly one ${key} element.`,
      origin,
    );
  }
  return normalizeText(
    values[0],
    `${context}.${key}`,
    maxBytes,
    origin,
    allowEmpty,
  );
};

const parseBoundedInteger = (
  value: string,
  field: string,
  origin: string,
  minimum: number,
): number => {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    return fail(
      'invalid_record',
      `${field} must be a canonical decimal integer.`,
      origin,
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > 2_147_483_647
  ) {
    return fail(
      'invalid_record',
      `${field} must be between ${minimum} and 2147483647.`,
      origin,
    );
  }
  return parsed;
};

const readIntegerElement = (
  record: XmlRecord,
  key: string,
  context: string,
  origin: string,
  minimum: number,
): number =>
  parseBoundedInteger(
    readSingleElement(record, key, context, 16, origin),
    `${context}.${key}`,
    origin,
    minimum,
  );

const readIntegerList = (
  record: XmlRecord,
  wrapperKey: 'indexes' | 'blocks',
  itemKey: 'index' | 'block',
  limit: number,
  context: string,
  origin: string,
  preserveOrder = false,
): readonly number[] => {
  const wrappers = record[wrapperKey];
  if (!Array.isArray(wrappers) || wrappers.length !== 1) {
    return fail(
      'invalid_record',
      `${context} requires exactly one ${wrapperKey} element.`,
      origin,
    );
  }
  const wrapper: unknown = wrappers[0] as unknown;
  if (!isRecord(wrapper)) {
    return fail(
      'invalid_record',
      `${context}.${wrapperKey} must contain at least one ${itemKey}.`,
      origin,
    );
  }
  assertOnlyKeys(
    wrapper,
    new Set([itemKey]),
    `${context}.${wrapperKey}`,
    origin,
    'invalid_record',
  );
  const values = wrapper[itemKey];
  if (!Array.isArray(values) || values.length === 0) {
    return fail(
      'invalid_record',
      `${context}.${wrapperKey} must contain at least one ${itemKey}.`,
      origin,
    );
  }
  if (values.length > limit) {
    return fail(
      'invalid_record',
      `${context}.${wrapperKey} contains ${values.length} values; the limit is ${limit}.`,
      origin,
    );
  }
  const parsed = values.map((value, index) =>
    parseBoundedInteger(
      normalizeText(
        value,
        `${context}.${wrapperKey}.${itemKey}[${index}]`,
        16,
        origin,
      ),
      `${context}.${wrapperKey}.${itemKey}[${index}]`,
      origin,
      0,
    ),
  );
  const unique = new Set(parsed);
  if (unique.size !== parsed.length) {
    return fail(
      'invalid_record',
      `${context}.${wrapperKey} contains duplicate values.`,
      origin,
    );
  }
  return preserveOrder
    ? parsed
    : [...parsed].sort((left, right) => left - right);
};

const parseTestList = (
  value: string,
  field: string,
  origin: string,
): readonly string[] => {
  if (value.length === 0) {
    return [];
  }
  const tests = value
    .split('|')
    .map((test, index) =>
      normalizeText(
        test,
        `${field}[${index}]`,
        PIT_XML_LIMITS.test_name_bytes,
        origin,
      ),
    );
  const unique = new Set(tests);
  if (unique.size !== tests.length) {
    return fail(
      'invalid_record',
      `${field} contains duplicate test names.`,
      origin,
    );
  }
  return [...tests].sort(compareText);
};

const readTestMatrix = (
  record: XmlRecord,
  context: string,
  origin: string,
): PitTestMatrix => {
  const hasSummary = record.killingTest !== undefined;
  const fullKeys = [
    'killingTests',
    'succeedingTests',
    'coveringTests',
  ] as const;
  const presentFullKeys = fullKeys.filter((key) => record[key] !== undefined);
  if (hasSummary && presentFullKeys.length > 0) {
    return fail(
      'invalid_record',
      `${context} mixes summary and full mutation-matrix fields.`,
      origin,
    );
  }
  if (!hasSummary && presentFullKeys.length !== fullKeys.length) {
    return fail(
      'invalid_record',
      `${context} requires killingTest or all full mutation-matrix fields.`,
      origin,
    );
  }
  if (hasSummary) {
    const killingTest = readSingleElement(
      record,
      'killingTest',
      context,
      PIT_XML_LIMITS.test_name_bytes,
      origin,
      true,
    );
    return {
      mode: 'summary',
      killing_tests:
        killingTest.length === 0
          ? []
          : parseTestList(killingTest, 'killingTest', origin),
      succeeding_tests: [],
      covering_tests: [],
    };
  }
  const matrix: PitTestMatrix = {
    mode: 'full',
    killing_tests: parseTestList(
      readSingleElement(
        record,
        'killingTests',
        context,
        PIT_XML_LIMITS.test_list_bytes,
        origin,
        true,
      ),
      `${context}.killingTests`,
      origin,
    ),
    succeeding_tests: parseTestList(
      readSingleElement(
        record,
        'succeedingTests',
        context,
        PIT_XML_LIMITS.test_list_bytes,
        origin,
        true,
      ),
      `${context}.succeedingTests`,
      origin,
    ),
    covering_tests: parseTestList(
      readSingleElement(
        record,
        'coveringTests',
        context,
        PIT_XML_LIMITS.test_list_bytes,
        origin,
        true,
      ),
      `${context}.coveringTests`,
      origin,
    ),
  };
  const killing = new Set(matrix.killing_tests);
  if (matrix.succeeding_tests.some((test) => killing.has(test))) {
    return fail(
      'invalid_record',
      `${context} contains a test in both killingTests and succeedingTests.`,
      origin,
    );
  }
  const covering = new Set(matrix.covering_tests);
  if (
    [...matrix.killing_tests, ...matrix.succeeding_tests].some(
      (test) => !covering.has(test),
    )
  ) {
    return fail(
      'invalid_record',
      `${context} contains a killing or succeeding test absent from coveringTests.`,
      origin,
    );
  }
  return matrix;
};

const parseStatus = (
  value: string,
  context: string,
  origin: string,
): PitStatus => {
  if (!Object.hasOwn(STATUS_DEFINITIONS, value)) {
    return fail(
      'invalid_record',
      `${context} has unsupported PIT status ${JSON.stringify(value)}.`,
      origin,
    );
  }
  return value as PitStatus;
};

const canonicalMutationIdentity = (
  mutation: Pick<
    PitMutation,
    | 'mutated_class'
    | 'mutated_method'
    | 'method_descriptor'
    | 'mutator'
    | 'indexes'
  >,
): string =>
  JSON.stringify([
    'craftcompass-pit-mutation-v1',
    mutation.mutated_class,
    mutation.mutated_method,
    mutation.method_descriptor,
    mutation.mutator,
    mutation.indexes,
  ]);

const parseMutation = (
  value: unknown,
  index: number,
  origin: string,
): PitMutation => {
  const context = `mutation[${index}]`;
  if (!isRecord(value)) {
    return fail(
      'invalid_record',
      `${context} must be an element with PIT mutation fields.`,
      origin,
    );
  }
  assertOnlyKeys(value, MUTATION_KEYS, context, origin, 'invalid_record');

  const pitStatus = parseStatus(
    readAttribute(value, 'status', context, origin),
    context,
    origin,
  );
  const statusDefinition = STATUS_DEFINITIONS[pitStatus];
  const detectedText = readAttribute(value, 'detected', context, origin);
  if (detectedText !== 'true' && detectedText !== 'false') {
    return fail(
      'invalid_record',
      `${context}.detected must be true or false.`,
      origin,
    );
  }
  const detected = detectedText === 'true';
  if (detected !== statusDefinition.detected) {
    return fail(
      'invalid_record',
      `${context}.detected is inconsistent with PIT status ${pitStatus}.`,
      origin,
    );
  }

  const testsRun = parseBoundedInteger(
    readAttribute(value, 'numberOfTestsRun', context, origin),
    `${context}.numberOfTestsRun`,
    origin,
    0,
  );
  const sourcePath = normalizeSafeRelativePath(
    readSingleElement(
      value,
      'sourceFile',
      context,
      PIT_XML_LIMITS.source_file_bytes,
      origin,
    ),
    `${context}.sourceFile`,
    PIT_XML_LIMITS.source_file_bytes,
    origin,
    'invalid_record',
  );
  const mutatedClass = readSingleElement(
    value,
    'mutatedClass',
    context,
    PIT_XML_LIMITS.class_bytes,
    origin,
  );
  const mutatedMethod = readSingleElement(
    value,
    'mutatedMethod',
    context,
    PIT_XML_LIMITS.method_bytes,
    origin,
  );
  const methodDescriptor = readSingleElement(
    value,
    'methodDescription',
    context,
    PIT_XML_LIMITS.method_descriptor_bytes,
    origin,
  );
  const line = readIntegerElement(value, 'lineNumber', context, origin, 0);
  const mutator = readSingleElement(
    value,
    'mutator',
    context,
    PIT_XML_LIMITS.mutator_bytes,
    origin,
  );
  const indexes = readIntegerList(
    value,
    'indexes',
    'index',
    PIT_XML_LIMITS.indexes_per_mutation,
    context,
    origin,
    true,
  );
  const blocks = readIntegerList(
    value,
    'blocks',
    'block',
    PIT_XML_LIMITS.blocks_per_mutation,
    context,
    origin,
  );
  const tests = readTestMatrix(value, context, origin);
  if (pitStatus !== 'KILLED' && tests.killing_tests.length > 0) {
    return fail(
      'invalid_record',
      `${context} supplies a killing test for non-killed status ${pitStatus}.`,
      origin,
    );
  }
  const description = readSingleElement(
    value,
    'description',
    context,
    PIT_XML_LIMITS.description_bytes,
    origin,
  );

  const identityFields = {
    source_file: sourcePath,
    mutated_class: mutatedClass,
    mutated_method: mutatedMethod,
    method_descriptor: methodDescriptor,
    line,
    mutator,
    indexes,
    blocks,
  };
  const id = `PIT-MUTANT-SHA256-${sha256(
    canonicalMutationIdentity(identityFields),
  )}`;
  const base = {
    id,
    pit_status: pitStatus,
    detected,
    tests_run: testsRun,
    ...identityFields,
    description,
    tests,
  };

  if (pitStatus === 'KILLED') {
    const killed: PitKilledMutation = {
      ...base,
      pit_status: 'KILLED',
      outcome: 'killed',
      action: null,
      equivalent_classification: null,
    };
    return killed;
  }
  if (statusDefinition.action === null) {
    throw new Error(`Missing actionable PIT status mapping for ${pitStatus}.`);
  }

  const actionable: PitActionableMutation = {
    ...base,
    outcome: statusDefinition.outcome,
    action: { ...statusDefinition.action },
    equivalent_classification:
      pitStatus === 'EQUIVALENT' ? { ...EQUIVALENT_CANDIDATE } : null,
  };
  return actionable;
};

const calculateTotals = (
  mutations: readonly PitMutation[],
): PitMutationTotals => {
  const count = (outcome: PitMutationOutcome): number =>
    mutations.filter((mutation) => mutation.outcome === outcome).length;
  return {
    generated: mutations.length,
    killed: count('killed'),
    survived: count('survived'),
    no_coverage: count('no_coverage'),
    timed_out: count('timed_out'),
    non_viable: count('non_viable'),
    memory_error: count('memory_error'),
    run_error: count('run_error'),
    equivalent_candidates: count('equivalent_candidate'),
    actionable: mutations.filter((mutation) => mutation.action !== null).length,
  };
};

/**
 * Parse one current-format PIT mutations.xml document without filesystem I/O.
 *
 * The caller supplies a repository-relative logical origin. Stable IDs exclude
 * that origin, input ordering, descriptions, and wall-clock metadata.
 */
export const parsePitXml = (
  input: string | Uint8Array,
  logicalOrigin: string,
): PitMutationRun => {
  const origin = normalizeOrigin(logicalOrigin);
  const source = decodeInput(input, origin);
  validateXmlEnvelope(source, origin);
  const root = parseXml(source, origin);
  assertOnlyKeys(root, ROOT_KEYS, 'mutations root', origin, 'invalid_root');

  const partialText = readAttribute(root, 'partial', 'mutations root', origin);
  if (partialText !== 'true' && partialText !== 'false') {
    return fail(
      'invalid_root',
      'mutations root partial attribute must be true or false.',
      origin,
    );
  }

  const rawMutations = root.mutation;
  if (rawMutations !== undefined && !Array.isArray(rawMutations)) {
    return fail(
      'invalid_root',
      'mutations root contains an ambiguous mutation collection.',
      origin,
    );
  }
  if (
    rawMutations !== undefined &&
    rawMutations.length > PIT_XML_LIMITS.mutation_records
  ) {
    return fail(
      'record_limit_exceeded',
      `PIT XML contains ${rawMutations.length} mutation records; the limit is ${PIT_XML_LIMITS.mutation_records}.`,
      origin,
    );
  }
  const mutations = (rawMutations ?? []).map((mutation, index) =>
    parseMutation(mutation, index, origin),
  );

  const seen = new Map<string, number>();
  mutations.forEach((mutation, index) => {
    const previousIndex = seen.get(mutation.id);
    if (previousIndex !== undefined) {
      fail(
        'duplicate_mutation',
        `mutation[${index}] duplicates the semantic identity of mutation[${previousIndex}] (${mutation.id}).`,
        origin,
      );
    }
    seen.set(mutation.id, index);
  });

  const sortedMutations = [...mutations].sort((left, right) =>
    compareText(left.id, right.id),
  );
  const partial = partialText === 'true';
  const runIdentity = JSON.stringify([
    'craftcompass-pit-run-v1',
    partial,
    sortedMutations.map((mutation) => [
      mutation.id,
      mutation.pit_status,
      mutation.tests_run,
      mutation.tests.mode,
      mutation.tests.killing_tests,
      mutation.tests.succeeding_tests,
      mutation.tests.covering_tests,
    ]),
  ]);

  return registerParsedPitRun({
    id: `PIT-RUN-SHA256-${sha256(runIdentity)}`,
    provider: 'pitest',
    format: 'pitest-xml',
    origin,
    partial,
    totals: calculateTotals(sortedMutations),
    mutations: sortedMutations,
  });
};
