// Story 7.4 (SR12): the leak sweep. Searches every captured output for every
// known value of the leak attack test:
//
//   node helm/tests/attack/leak-sweep.mjs <values.json> <file...>
//
// values.json is a list of { name, value } (leak-backend.ts writes it in the
// test pod; leak-attack-test.sh adds the runner's own). Each value is searched
// for whole, as base64 and base64url, JSON-escaped and URL-encoded, and, when
// it is 16 characters or longer, each half and (as tokenForms in
// oauth-key-helper.mjs, Story 7.2) the stable middle of its base64 and
// base64url at byte offsets 0, 1 and 2, so the value encoded inside a longer
// string is found too. Forms shorter than 8 characters are dropped.
//
// Prints "ok   - <file>: ..." per clean file and
// "FAIL - <value name> found in <file basename>" per hit; never a value or a
// form. A missing or empty file, or a missing or empty values file, is a
// FAIL. Exits 1 on any FAIL.
import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const MIN_FORM = 8;

/** Every form of one value the sweep searches for, longest first, without duplicates. */
export function valueForms(value) {
  const forms = [value];
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  forms.push(b64, b64.replace(/=+$/, ''), Buffer.from(value, 'utf8').toString('base64url'));
  const json = JSON.stringify(value).slice(1, -1);
  forms.push(json, encodeURIComponent(value));
  if (value.length >= 16) {
    const half = Math.floor(value.length / 2);
    forms.push(value.slice(0, half), value.slice(half));
    for (const k of [0, 1, 2]) {
      const bytes = Buffer.concat([Buffer.alloc(k), Buffer.from(value, 'utf8')]);
      const inner = bytes.toString('base64').replace(/=+$/, '');
      const innerUrl = bytes.toString('base64url');
      if (inner.length > 8) forms.push(inner.slice(4, -4), innerUrl.slice(4, -4));
    }
  }
  return [...new Set(forms.filter((f) => typeof f === 'string' && f.length >= MIN_FORM))].sort((a, b) => b.length - a.length);
}

/** Reads values.json: a non-empty list of { name, value } with string values. */
export function readValues(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('the values file is not a list');
  const values = parsed.filter((v) => v && typeof v.name === 'string' && typeof v.value === 'string' && v.value.trim() !== '');
  if (values.length === 0) throw new Error('the values file holds no value');
  return values;
}

/** Sweeps the files; returns { lines, fails }. Lines never hold a value. */
export function sweep(values, files) {
  const lines = [];
  let fails = 0;
  const fail = (text) => {
    fails += 1;
    lines.push(`FAIL - ${text}`);
  };
  const forms = values.map((v) => ({ name: v.name, forms: valueForms(v.value) }));
  const formCount = forms.reduce((n, v) => n + v.forms.length, 0);
  for (const file of files) {
    const name = basename(file);
    let text;
    try {
      if (statSync(file).size === 0) {
        fail(`${name} is missing or empty`);
        continue;
      }
      text = readFileSync(file, 'utf8');
    } catch {
      fail(`${name} is missing or empty`);
      continue;
    }
    let hits = 0;
    for (const value of forms) {
      if (value.forms.some((form) => text.includes(form))) {
        hits += 1;
        fail(`${value.name} found in ${name}`);
      }
    }
    if (hits === 0) lines.push(`ok   - ${name}: no known value (${values.length} values, ${formCount} forms, ${text.length} characters)`);
  }
  return { lines, fails };
}

export function main(argv) {
  const [valuesFile, ...files] = argv;
  if (!valuesFile || files.length === 0) {
    console.log('usage: node leak-sweep.mjs <values.json> <file...>');
    return 2;
  }
  let values;
  try {
    values = readValues(valuesFile);
  } catch (error) {
    console.log(`FAIL - ${basename(valuesFile)} could not be read: ${error instanceof SyntaxError ? 'not JSON' : error.message.replace(/:.*$/, '')}`);
    return 1;
  }
  const { lines, fails } = sweep(values, files);
  for (const line of lines) console.log(line);
  console.log(fails === 0 ? `leak sweep: ${files.length} outputs, no known value` : `leak sweep: ${fails} FAIL`);
  return fails === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && basename(process.argv[1]) === 'leak-sweep.mjs') {
  process.exit(main(process.argv.slice(2)));
}
