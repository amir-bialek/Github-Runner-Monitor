// Story 7.2: builds the upload of one agent attack scenario from the fixture
// trees next to this file, the way the backend uploads to a Debug Job
// receiver: the log, and one gzip tar per repository with a GitHub-style
// acme-<repo>-<sha>/ root folder (the receiver strips the first path part).
//
//   node make-fixtures.mjs bundle <scenario>   prints {"folders", "log", "repos"} (base64) as JSON
//   node make-fixtures.mjs canaries            prints the canaries as name=value,name=value
//   node make-fixtures.mjs list <scenario>     prints the uploaded paths, one per line
//
// <scenario>/folders.txt lists the folders, failing repository first;
// <scenario>/log.txt is the job log; <scenario>/repos/<folder>/ the files.
// The hostile files are kept inert in this repository: a path part
// "dot-<name>" becomes ".<name>" and a ".fixture" file suffix is dropped
// (so CLAUDE.md.fixture is uploaded as CLAUDE.md, dot-claude/ as .claude/).
// Everything is invented.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCENARIOS = ['repo-config', 'inject-command', 'inject-secrets', 'inject-target'];
const MTIME = Math.floor(Date.parse('2026-11-05T09:00:00Z') / 1000);

/** The uploaded name of a fixture path ("dot-claude/x.md.fixture" -> ".claude/x.md"). */
export function uploadedPath(path) {
  return path
    .split('/')
    .map((part) => (part.startsWith('dot-') ? `.${part.slice(4)}` : part))
    .join('/')
    .replace(/\.fixture$/, '');
}

function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push({ path: uploadedPath(rel), data: readFileSync(full) });
  }
  return out;
}

function octal(value, length) {
  return `${value.toString(8).padStart(length - 1, '0')}\0`;
}

function header(name, size, type) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar path too long: ${name}`);
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write(octal(type === '5' ? 0o755 : 0o644, 8), 100, 'ascii');
  block.write(octal(1000, 8), 108, 'ascii');
  block.write(octal(1000, 8), 116, 'ascii');
  block.write(octal(size, 12), 124, 'ascii');
  block.write(octal(MTIME, 12), 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write('acme', 265, 'ascii');
  block.write('acme', 297, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}

/** A gzip ustar archive of the files under root/ (a folder entry, then each file). */
export function tarGz(root, files) {
  const parts = [header(`${root}/`, 0, '5')];
  for (const file of files) {
    parts.push(header(`${root}/${file.path}`, file.data.length, '0'), file.data);
    const pad = (512 - (file.data.length % 512)) % 512;
    if (pad > 0) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function shortSha(folder) {
  let h = 0x811c9dc5;
  for (const c of folder) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0').slice(0, 7);
}

export function folders(scenario) {
  return readFileSync(join(HERE, scenario, 'folders.txt'), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/** The upload of one scenario: { folders, log, repos: { folder: base64 tgz } }. */
export function bundle(scenario) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`unknown scenario ${scenario}`);
  const list = folders(scenario);
  const repos = {};
  for (const folder of list) {
    const files = walk(join(HERE, scenario, 'repos', folder));
    repos[folder] = tarGz(`acme-${folder}-${shortSha(folder)}`, files).toString('base64');
  }
  return { folders: list, log: readFileSync(join(HERE, scenario, 'log.txt')).toString('base64'), repos };
}

/** [{ name, value }] from canaries.txt. */
export function canaries() {
  return readFileSync(join(HERE, 'canaries.txt'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return { name: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
    });
}

if (process.argv[1] !== undefined && basename(process.argv[1]) === 'make-fixtures.mjs') {
  const [mode, scenario] = process.argv.slice(2);
  if (mode === 'bundle') {
    process.stdout.write(`${JSON.stringify(bundle(scenario))}\n`);
  } else if (mode === 'canaries') {
    process.stdout.write(`${canaries().map((c) => `${c.name}=${c.value}`).join(',')}\n`);
  } else if (mode === 'list') {
    for (const folder of folders(scenario)) {
      for (const file of walk(join(HERE, scenario, 'repos', folder))) console.log(`${folder}/${file.path}`);
    }
  } else {
    console.error('usage: node make-fixtures.mjs bundle <scenario> | canaries | list <scenario>');
    process.exit(2);
  }
}
