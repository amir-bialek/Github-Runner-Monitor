import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createResultValidator,
  loadResultSchema,
  ResultSchemaError,
  validateResult,
  type ValidationOutcome,
} from '../src/services/debugIt/resultSchema';

// Tests run with cwd code/backend, so this is the real shared schema file.
const SCHEMA_PATH = resolve(process.cwd(), '../debug-job/schema/result.v1.json');
const FIXTURES = resolve(process.cwd(), 'tests/fixtures/debug-results');

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

function base(): Record<string, unknown> {
  return fixture('with-patch.json');
}

function errorsOf(outcome: ValidationOutcome): string[] {
  if (outcome.ok) throw new Error('expected the result to be rejected');
  return outcome.errors;
}

function rejectedNaming(body: unknown, field: string): string[] {
  const errors = errorsOf(validateResult(JSON.stringify(body)));
  expect(errors.some((e) => e.startsWith(`${field}:`) || e.startsWith(`${field}.`))).toBe(true);
  return errors;
}

describe('result schema file', () => {
  const schema = loadResultSchema(SCHEMA_PATH) as {
    'x-maxBodyBytes': number;
    required: string[];
    properties: Record<string, Record<string, unknown>>;
  };

  it('defines schemaVersion 1 and every field, all required', () => {
    expect(schema.properties.schemaVersion).toMatchObject({ const: 1 });
    expect(schema.required.sort()).toEqual([
      'causeLocation', 'costUsd', 'durationMs', 'explanation', 'failureReason',
      'inputTokens', 'logTruncated', 'outputTokens', 'patch', 'schemaVersion',
    ]);
    expect(Object.keys(schema.properties).sort()).toEqual([...schema.required].sort());
    expect(schema.properties.failureReason).toMatchObject({ enum: ['none', 'time-limit', 'spend-limit', 'error'] });
    expect(schema['x-maxBodyBytes']).toBe(262144);
  });

  it('lists every cause location kind', () => {
    const forms = schema.properties.causeLocation!.oneOf as Array<{ properties: { kind: { enum?: string[]; const?: string } } }>;
    const kinds = forms.flatMap((f) => f.properties.kind.enum ?? [f.properties.kind.const!]);
    expect(kinds.sort()).toEqual(
      ['extra-repository', 'infrastructure', 'runner', 'this-repository', 'unknown', 'workflow-file'],
    );
  });

  it('documents the patch prefixes and that an empty patch is valid', () => {
    const description = schema.properties.patch!.description as string;
    expect(description).toContain('a/{folder}/{path}');
    expect(description).toContain('b/{folder}/{path}');
    expect(description).toMatch(/empty patch .* is valid/i);
  });
});

describe('fixtures', () => {
  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json'));

  it('includes the expected valid fixtures', () => {
    expect(files.sort()).toEqual(['empty-patch-runner.json', 'extra-repository.json', 'time-limit.json', 'with-patch.json']);
  });

  it.each(files)('%s passes against the real schema file', (file) => {
    const raw = readFileSync(join(FIXTURES, file));
    const outcome = createResultValidator(loadResultSchema(SCHEMA_PATH))(raw);
    expect(outcome).toEqual({ ok: true, result: JSON.parse(raw.toString('utf8')) });
  });
});

describe('validateResult', () => {
  it('accepts a valid result with a patch', () => {
    const body = base();
    expect(validateResult(JSON.stringify(body))).toEqual({ ok: true, result: body });
  });

  it('accepts an empty patch for a runner cause', () => {
    const body = { ...base(), patch: '', causeLocation: { kind: 'runner' } };
    expect(validateResult(JSON.stringify(body)).ok).toBe(true);
  });

  it('accepts a named extra repository', () => {
    const body = { ...base(), causeLocation: { kind: 'extra-repository', repository: 'payments-api' } };
    expect(validateResult(Buffer.from(JSON.stringify(body))).ok).toBe(true);
  });

  it('rejects an extra repository without a name', () => {
    rejectedNaming({ ...base(), causeLocation: { kind: 'extra-repository' } }, 'causeLocation');
  });

  it('rejects a repository name on another kind', () => {
    rejectedNaming({ ...base(), causeLocation: { kind: 'unknown', repository: 'x' } }, 'causeLocation');
  });

  it('rejects a repository name with a bad format', () => {
    rejectedNaming({ ...base(), causeLocation: { kind: 'extra-repository', repository: '../etc' } }, 'causeLocation');
  });

  it.each(['.', '..'])('rejects the extra repository name %j', (name) => {
    rejectedNaming({ ...base(), causeLocation: { kind: 'extra-repository', repository: name } }, 'causeLocation');
  });

  it('accepts an extra repository name containing dots', () => {
    const body = { ...base(), causeLocation: { kind: 'extra-repository', repository: 'acme.payments-api' } };
    expect(validateResult(JSON.stringify(body)).ok).toBe(true);
  });

  it('rejects another schema version', () => {
    rejectedNaming({ ...base(), schemaVersion: 2 }, 'schemaVersion');
  });

  it('rejects a missing field', () => {
    const body = base();
    delete body.durationMs;
    rejectedNaming(body, 'durationMs');
  });

  it.each([
    ['costUsd', '0.4'],
    ['inputTokens', 1.5],
    ['logTruncated', 'no'],
    ['explanation', 42],
    ['patch', null],
    ['durationMs', -1],
    ['costUsd', -0.01],
    ['explanation', ''],
    ['outputTokens', 1.5],
    ['outputTokens', -1],
    ['inputTokens', -1],
    ['durationMs', 1.5],
    ['inputTokens', 1e300],
    ['durationMs', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a wrong value for %s', (field, value) => {
    rejectedNaming({ ...base(), [field]: value }, field);
  });

  it('rejects an extra field, naming it without echoing its value', () => {
    const secret = 'sk-ant-acme-secret-value';
    const errors = rejectedNaming({ ...base(), token: secret }, 'token');
    expect(errors.join('\n')).not.toContain(secret);
  });

  it('does not echo a suspicious extra field name', () => {
    const name = 'sk-ant-acme secret <script>';
    const errors = errorsOf(validateResult(JSON.stringify({ ...base(), [name]: 1 })));
    expect(errors.join('\n')).not.toContain(name);
    expect(errors.join('\n')).toContain('(unnamed property)');
  });

  it('rejects a bad enum value without echoing it', () => {
    const errors = rejectedNaming({ ...base(), failureReason: 'crashed' }, 'failureReason');
    expect(errors.join('\n')).not.toContain('crashed');
  });

  it('never echoes offending values in any error', () => {
    const marker = 'payments-api-marker-value';
    const errors = errorsOf(validateResult(JSON.stringify({
      ...base(),
      schemaVersion: marker,
      explanation: { marker },
      causeLocation: { kind: marker, repository: marker },
      costUsd: marker,
      failureReason: marker,
      token: marker,
    })));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).not.toContain(marker);
  });

  it('rejects a body over the size limit before parsing', () => {
    const limit = (loadResultSchema(SCHEMA_PATH) as { 'x-maxBodyBytes': number })['x-maxBodyBytes'];
    validateResult('{}'); // make sure the default schema is already loaded
    const parse = jest.spyOn(JSON, 'parse');
    try {
      const errors = errorsOf(validateResult('x'.repeat(limit + 1)));
      expect(errors).toEqual([expect.stringContaining('over the size limit')]);
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('measures the limit in UTF-8 bytes, not characters', () => {
    const limit = (loadResultSchema(SCHEMA_PATH) as { 'x-maxBodyBytes': number })['x-maxBodyBytes'];
    const body = JSON.stringify({ ...base(), explanation: '' });
    const filler = 'é'.repeat(Math.ceil((limit - body.length) / 2) + 1); // 2 bytes each
    const big = JSON.stringify({ ...base(), explanation: filler });
    expect(big.length).toBeLessThanOrEqual(limit);
    expect(errorsOf(validateResult(big))).toEqual([expect.stringContaining('over the size limit')]);
  });

  it('accepts a body of exactly the size limit', () => {
    const limit = (loadResultSchema(SCHEMA_PATH) as { 'x-maxBodyBytes': number })['x-maxBodyBytes'];
    const body = JSON.stringify({ ...base(), explanation: '' });
    const exact = JSON.stringify({ ...base(), explanation: 'a'.repeat(limit - body.length) });
    expect(Buffer.byteLength(exact)).toBe(limit);
    expect(validateResult(exact).ok).toBe(true);
  });

  it.each([
    ['[]', 'not a JSON object'],
    ['null', 'not a JSON object'],
    ['"text"', 'not a JSON object'],
    ['nul', 'not valid JSON'],
    ['', 'not valid JSON'],
  ])('rejects %j as %s', (raw, message) => {
    expect(errorsOf(validateResult(raw))).toEqual([expect.stringContaining(message)]);
  });

  it('rejects a buffer that is not valid UTF-8', () => {
    expect(errorsOf(validateResult(Buffer.from([0x7b, 0xff, 0x7d])))).toEqual([expect.stringContaining('not valid JSON')]);
  });
});

describe('createResultValidator', () => {
  function realSchema(): Record<string, unknown> {
    return loadResultSchema(SCHEMA_PATH) as Record<string, unknown>;
  }

  it('rejects a schema containing an unsupported keyword', () => {
    const schema = realSchema();
    (schema.properties as Record<string, Record<string, unknown>>).patch!.format = 'diff';
    expect(() => createResultValidator(schema)).toThrow(ResultSchemaError);
    expect(() => createResultValidator(schema)).toThrow(/unsupported keyword "format"/);
  });

  it('rejects an unsupported keyword at the top level', () => {
    expect(() => createResultValidator({ ...realSchema(), allOf: [] })).toThrow(ResultSchemaError);
  });

  it('rejects additionalProperties: true', () => {
    expect(() => createResultValidator({ ...realSchema(), additionalProperties: true })).toThrow(/additionalProperties/);
  });

  it('rejects an invalid pattern regex', () => {
    const schema = realSchema();
    (schema.properties as Record<string, Record<string, unknown>>).patch!.pattern = '([';
    expect(() => createResultValidator(schema)).toThrow(/pattern is not a valid regular expression/);
  });

  it('rejects a wrong $schema value', () => {
    expect(() => createResultValidator({ ...realSchema(), $schema: 'http://json-schema.org/draft-07/schema#' }))
      .toThrow(/\$schema/);
  });

  it('checks a property named __proto__ like any other', () => {
    const schema = JSON.parse(
      '{"x-maxBodyBytes":100,"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string"}}}',
    ) as unknown;
    const validate = createResultValidator(schema);
    expect(errorsOf(validate('{"__proto__":5}'))).toEqual([expect.stringContaining('__proto__: must be of type string')]);
  });

  it('rejects a schema without x-maxBodyBytes', () => {
    const schema = realSchema();
    delete schema['x-maxBodyBytes'];
    expect(() => createResultValidator(schema)).toThrow(/x-maxBodyBytes/);
  });

  it('takes its rules from the schema it is given', () => {
    const schema = realSchema();
    schema['x-maxBodyBytes'] = 10;
    expect(errorsOf(createResultValidator(schema)(JSON.stringify(base())))).toEqual([
      expect.stringContaining('over the size limit'),
    ]);
  });

  it('reports a missing schema file', () => {
    expect(() => loadResultSchema('/nonexistent/acme/result.v1.json')).toThrow(ResultSchemaError);
  });
});
