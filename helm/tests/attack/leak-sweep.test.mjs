// Story 7.4: unit tests of leak-sweep.mjs. Each form is found (whole, base64,
// base64url, either half, base64 inside a longer string), a clean file
// passes, a missing or empty file fails, and no value ever appears in the
// output.
//
//   node --test helm/tests/attack/leak-sweep.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sweep, valueForms } from './leak-sweep.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// Invented fake values only.
const VALUES = [
  { name: 'personal-anthropic-key', value: 'sk-ant-api03-leak-sweep-fake-personal-0123456789' },
  { name: 'session-cookie-1', value: 'Qm9ndXMtc2Vzc2lvbi1jb29raWUtdmFsdWUtZm9yLXRlc3Rz' },
  { name: 'short-code', value: 'abcd1234' },
];

function folder() {
  return mkdtempSync(join(tmpdir(), 'leak-sweep-'));
}

function write(dir, name, text) {
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

function run(...args) {
  const out = spawnSync(process.execPath, [join(here, 'leak-sweep.mjs'), ...args], { encoding: 'utf8' });
  return { status: out.status, text: `${out.stdout}${out.stderr}` };
}

describe('leak sweep', () => {
  const key = VALUES[0].value;
  const half = Math.floor(key.length / 2);
  const cases = [
    ['whole', key],
    ['base64', Buffer.from(key).toString('base64')],
    ['base64url', Buffer.from(key).toString('base64url')],
    ['first half', key.slice(0, half)],
    ['second half', key.slice(half)],
    ['base64 inside a longer string', Buffer.from(`prefix:${key}:suffix`).toString('base64')],
    ['base64url inside a longer string', Buffer.from(`xy${key}z`).toString('base64url')],
    ['JSON-escaped with a quote around it', JSON.stringify({ note: key })],
  ];
  for (const [label, text] of cases) {
    it(`finds the ${label} form`, () => {
      const dir = folder();
      const file = write(dir, 'out.txt', `some output ${text} more output\n`);
      const { lines, fails } = sweep(VALUES, [file]);
      assert.equal(fails, 1, lines.join('\n'));
      assert.deepEqual(lines, ['FAIL - personal-anthropic-key found in out.txt']);
    });
  }

  it('finds a value with a newline and a quote that appears only JSON-escaped', () => {
    const value = 'fake-pem-line-one\nfake "quoted" line two';
    const dir = folder();
    const text = JSON.stringify({ body: value });
    assert.equal(text.includes(value), false);
    const { lines, fails } = sweep([{ name: 'multi-line', value }], [write(dir, 'escaped.json', text)]);
    assert.equal(fails, 1, lines.join('\n'));
    assert.deepEqual(lines, ['FAIL - multi-line found in escaped.json']);
  });

  it('finds a value with / + = that appears only URL-encoded', () => {
    const value = 'fake/token+value=end0';
    const dir = folder();
    const text = `GET /callback?code=${encodeURIComponent(value)}&x=1`;
    assert.equal(text.includes(value), false);
    const { lines, fails } = sweep([{ name: 'url-token', value }], [write(dir, 'url.txt', text)]);
    assert.equal(fails, 1, lines.join('\n'));
    assert.deepEqual(lines, ['FAIL - url-token found in url.txt']);
  });

  it('finds a short value whole, but not its halves', () => {
    const dir = folder();
    assert.equal(sweep(VALUES, [write(dir, 'a.txt', 'x abcd1234 y')]).fails, 1);
    assert.equal(sweep(VALUES, [write(dir, 'b.txt', 'x abcd y 1234')]).fails, 0);
    assert.ok(!valueForms('abcd1234').includes('abcd'));
  });

  it('passes a clean file', () => {
    const dir = folder();
    const { lines, fails } = sweep(VALUES, [write(dir, 'clean.log', 'ok   - nothing secret here\n')]);
    assert.equal(fails, 0);
    assert.match(lines[0], /^ok {3}- clean\.log: no known value \(3 values, \d+ forms, \d+ characters\)$/);
  });

  it('fails a missing file and an empty file', () => {
    const dir = folder();
    const empty = write(dir, 'empty.txt', '');
    const { lines, fails } = sweep(VALUES, [join(dir, 'missing.txt'), empty]);
    assert.equal(fails, 2);
    assert.deepEqual(lines, ['FAIL - missing.txt is missing or empty', 'FAIL - empty.txt is missing or empty']);
  });

  it('never prints a value or a form, and exits 1 on a hit', () => {
    const dir = folder();
    const values = write(dir, 'values.json', JSON.stringify(VALUES));
    const leaky = write(
      dir,
      'leaky.txt',
      VALUES.map((v) => `${v.value} ${Buffer.from(v.value).toString('base64')}`).join('\n'),
    );
    const clean = write(dir, 'clean.txt', 'nothing here\n');
    const out = run(values, leaky, clean);
    assert.equal(out.status, 1);
    assert.match(out.text, /FAIL - personal-anthropic-key found in leaky\.txt/);
    assert.match(out.text, /FAIL - session-cookie-1 found in leaky\.txt/);
    assert.match(out.text, /FAIL - short-code found in leaky\.txt/);
    assert.match(out.text, /ok {3}- clean\.txt: no known value/);
    for (const v of VALUES) {
      for (const form of valueForms(v.value)) assert.equal(out.text.includes(form), false, `${v.name} form printed`);
    }
  });

  it('exits 0 when every file is clean, 1 when the values file is missing or empty', () => {
    const dir = folder();
    const values = write(dir, 'values.json', JSON.stringify(VALUES));
    const clean = write(dir, 'clean.txt', 'nothing here\n');
    assert.equal(run(values, clean).status, 0);
    assert.equal(run(join(dir, 'none.json'), clean).status, 1);
    assert.equal(run(write(dir, 'empty.json', '[]'), clean).status, 1);
  });
});
