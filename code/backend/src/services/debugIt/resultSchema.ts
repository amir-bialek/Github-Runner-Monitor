// Debug it result contract (AD-17): the Debug Job sends one JSON result per
// run, and this module checks it against code/debug-job/schema/result.v1.json,
// the only contract the two sides share. Every rule comes from that file: the
// interpreter below supports a small, fixed subset of JSON Schema and refuses
// to build from a schema that uses any other keyword, so the file can never
// gain a rule that is silently left unchecked.
//
// Results are untrusted text: error messages name the failing field path but
// never echo a value.
//
// The results port (story 3.9, routes/debugItResults.ts) builds its validator
// from this module at startup.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Default schema location, resolved from the working directory because the
 * runtime (tsx, ESM) and the tests (ts-jest, CommonJS) share no other safe
 * anchor: cwd is code/backend locally and in Jest, /app in the Docker image
 * (which copies the schema to /debug-job/schema).
 */
export const DEFAULT_RESULT_SCHEMA_PATH = '../debug-job/schema/result.v1.json';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

export type CauseLocation =
  | { kind: 'this-repository' | 'workflow-file' | 'runner' | 'infrastructure' | 'unknown' }
  | { kind: 'extra-repository'; repository: string };

/** A result that passed the schema. Every text field is still untrusted. */
export interface DebugResult {
  schemaVersion: 1;
  explanation: string;
  causeLocation: CauseLocation;
  patch: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  logTruncated: boolean;
  failureReason: 'none' | 'time-limit' | 'spend-limit' | 'error';
}

export type ValidationOutcome =
  | { ok: true; result: DebugResult }
  | { ok: false; errors: string[] };

export type ResultValidator = (raw: string | Buffer) => ValidationOutcome;

/** The schema file is missing, unreadable, or uses something the interpreter does not support. */
export class ResultSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResultSchemaError';
  }
}

type JsonType = 'object' | 'string' | 'number' | 'integer' | 'boolean';
type Primitive = string | number | boolean | null;

interface Node {
  type?: JsonType;
  hasConst: boolean;
  const?: Primitive;
  enum?: Primitive[];
  required?: string[];
  properties?: Record<string, Node>;
  closed: boolean;
  minimum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  oneOf?: Node[];
}

const NODE_KEYWORDS = new Set([
  'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'minimum', 'minLength', 'maxLength', 'pattern', 'oneOf', 'description',
]);
const ROOT_ONLY_KEYWORDS = new Set(['$schema', 'x-maxBodyBytes']);
const TYPES = new Set<JsonType>(['object', 'string', 'number', 'integer', 'boolean']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is Primitive {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function own(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Compiles one schema node, throwing ResultSchemaError on anything outside the supported subset. */
function compileNode(schema: unknown, where: string, root: boolean): Node {
  if (!isPlainObject(schema)) throw new ResultSchemaError(`Schema at ${where} is not an object.`);
  for (const key of Object.keys(schema)) {
    if (!NODE_KEYWORDS.has(key) && !(root && ROOT_ONLY_KEYWORDS.has(key))) {
      throw new ResultSchemaError(`Schema at ${where} uses unsupported keyword "${key}".`);
    }
  }
  const node: Node = { hasConst: false, closed: false };

  if (own(schema, 'description') && typeof schema.description !== 'string') {
    throw new ResultSchemaError(`Schema at ${where}: description must be a string.`);
  }
  if (own(schema, '$schema') && schema.$schema !== DRAFT_2020_12) {
    throw new ResultSchemaError(`Schema at ${where}: $schema must be ${DRAFT_2020_12}.`);
  }
  if (own(schema, 'type')) {
    if (typeof schema.type !== 'string' || !TYPES.has(schema.type as JsonType)) {
      throw new ResultSchemaError(`Schema at ${where}: unsupported type.`);
    }
    node.type = schema.type as JsonType;
  }
  if (own(schema, 'const')) {
    if (!isPrimitive(schema.const)) throw new ResultSchemaError(`Schema at ${where}: const must be a primitive.`);
    node.hasConst = true;
    node.const = schema.const;
  }
  if (own(schema, 'enum')) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0 || !schema.enum.every(isPrimitive)) {
      throw new ResultSchemaError(`Schema at ${where}: enum must be a non-empty list of primitives.`);
    }
    node.enum = schema.enum as Primitive[];
  }
  if (own(schema, 'properties')) {
    if (!isPlainObject(schema.properties)) throw new ResultSchemaError(`Schema at ${where}: properties must be an object.`);
    // No prototype, so a property named __proto__ is stored like any other.
    const props = Object.create(null) as Record<string, Node>;
    for (const [name, sub] of Object.entries(schema.properties)) {
      props[name] = compileNode(sub, `${where}.properties.${name}`, false);
    }
    node.properties = props;
  }
  if (own(schema, 'required')) {
    if (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === 'string')) {
      throw new ResultSchemaError(`Schema at ${where}: required must be a list of strings.`);
    }
    node.required = schema.required as string[];
  }
  if (own(schema, 'additionalProperties')) {
    if (schema.additionalProperties !== false) {
      throw new ResultSchemaError(`Schema at ${where}: only additionalProperties: false is supported.`);
    }
    node.closed = true;
  }
  if (own(schema, 'minimum')) {
    if (typeof schema.minimum !== 'number' || !Number.isFinite(schema.minimum)) {
      throw new ResultSchemaError(`Schema at ${where}: minimum must be a number.`);
    }
    node.minimum = schema.minimum;
  }
  for (const key of ['minLength', 'maxLength'] as const) {
    if (own(schema, key)) {
      if (!isNonNegativeInteger(schema[key])) {
        throw new ResultSchemaError(`Schema at ${where}: ${key} must be a non-negative integer.`);
      }
      node[key] = schema[key];
    }
  }
  if (own(schema, 'pattern')) {
    if (typeof schema.pattern !== 'string') throw new ResultSchemaError(`Schema at ${where}: pattern must be a string.`);
    try {
      node.pattern = new RegExp(schema.pattern, 'u');
    } catch {
      throw new ResultSchemaError(`Schema at ${where}: pattern is not a valid regular expression.`);
    }
  }
  if (own(schema, 'oneOf')) {
    if (!Array.isArray(schema.oneOf) || schema.oneOf.length === 0) {
      throw new ResultSchemaError(`Schema at ${where}: oneOf must be a non-empty list.`);
    }
    node.oneOf = schema.oneOf.map((sub, i) => compileNode(sub, `${where}.oneOf[${i}]`, false));
  }
  return node;
}

/** A property name from an untrusted result, shown only when it is plainly an identifier. */
function safeName(name: string): string {
  return /^[A-Za-z0-9_$-]{1,64}$/.test(name) ? name : '(unnamed property)';
}

function join(path: string, name: string): string {
  return path === '' ? name : `${path}.${name}`;
}

function label(path: string): string {
  return path === '' ? 'result' : path;
}

function matchesType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case 'object': return isPlainObject(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    case 'boolean': return typeof value === 'boolean';
  }
}

/** Checks a value against a node, pushing value-free messages onto errors. */
function check(node: Node, value: unknown, path: string, errors: string[]): void {
  const at = label(path);
  if (node.type !== undefined && !matchesType(value, node.type)) {
    errors.push(`${at}: must be of type ${node.type}.`);
    return;
  }
  if (node.hasConst && value !== node.const) {
    errors.push(`${at}: must equal the fixed value ${JSON.stringify(node.const)}.`);
  }
  if (node.enum !== undefined && !node.enum.includes(value as Primitive)) {
    errors.push(`${at}: must be one of ${node.enum.map((v) => JSON.stringify(v)).join(', ')}.`);
  }
  if (typeof value === 'number' && node.minimum !== undefined && !(value >= node.minimum)) {
    errors.push(`${at}: must be at least ${node.minimum}.`);
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (node.minLength !== undefined && length < node.minLength) {
      errors.push(`${at}: must be at least ${node.minLength} characters long.`);
    }
    if (node.maxLength !== undefined && length > node.maxLength) {
      errors.push(`${at}: must be at most ${node.maxLength} characters long.`);
    }
    if (node.pattern !== undefined && !node.pattern.test(value)) {
      errors.push(`${at}: has an invalid format.`);
    }
  }
  if (isPlainObject(value)) {
    for (const name of node.required ?? []) {
      if (!own(value, name)) errors.push(`${join(path, name)}: is required.`);
    }
    for (const name of Object.keys(value)) {
      const sub = node.properties !== undefined && own(node.properties, name) ? node.properties[name] : undefined;
      if (sub !== undefined) {
        check(sub, value[name], join(path, name), errors);
      } else if (node.closed) {
        errors.push(`${join(path, safeName(name))}: is not an allowed field.`);
      }
    }
  }
  if (node.oneOf !== undefined) {
    const matches = node.oneOf.filter((sub) => {
      const subErrors: string[] = [];
      check(sub, value, path, subErrors);
      return subErrors.length === 0;
    }).length;
    if (matches !== 1) errors.push(`${at}: must match exactly one allowed form.`);
  }
}

/** Reads and parses the schema file. Defaults to the shared file next to code/backend. */
export function loadResultSchema(path: string = resolve(process.cwd(), DEFAULT_RESULT_SCHEMA_PATH)): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new ResultSchemaError(`Result schema could not be read from ${path}.`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ResultSchemaError(`Result schema at ${path} is not valid JSON.`);
  }
}

/** Builds a validator from a parsed schema. Throws ResultSchemaError on any unsupported keyword. */
export function createResultValidator(schema: unknown): ResultValidator {
  const root = compileNode(schema, '#', true);
  const maxBodyBytes = (schema as Record<string, unknown>)['x-maxBodyBytes'];
  if (!isNonNegativeInteger(maxBodyBytes) || maxBodyBytes === 0) {
    throw new ResultSchemaError('Schema must set x-maxBodyBytes to a positive integer.');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });

  return (raw) => {
    const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
    if (size > maxBodyBytes) {
      return { ok: false, errors: [`result: body is over the size limit of ${maxBodyBytes} bytes.`] };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof raw === 'string' ? raw : decoder.decode(raw));
    } catch {
      return { ok: false, errors: ['result: body is not valid JSON.'] };
    }
    if (!isPlainObject(parsed)) {
      return { ok: false, errors: ['result: body is not a JSON object.'] };
    }
    const errors: string[] = [];
    check(root, parsed, '', errors);
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, result: parsed as unknown as DebugResult };
  };
}

let defaultValidator: ResultValidator | undefined;

/**
 * Validates a raw result body against the default schema file, loaded once on
 * first use. Returns the outcome union for any body, but throws
 * ResultSchemaError when the default schema cannot be loaded or compiled.
 */
export function validateResult(raw: string | Buffer): ValidationOutcome {
  defaultValidator ??= createResultValidator(loadResultSchema());
  return defaultValidator(raw);
}
