// Patch validation (story 4.1, Epic 4). The patch of a debug run is untrusted
// text: a hostile log may have steered the agent. validatePatch parses it in
// memory, groups its file sections by repository (download folder) and says
// per repository whether that part may become a fix pull request, or which
// rule it broke. It is pure: no git, no subprocess, no filesystem, no logging.
//
// The format is the one the Debug Job wrapper writes (debug-job/src/diff.ts):
// `--- a/{folder}/{path}` / `+++ b/{folder}/{path}` file headers followed by
// `@@` hunks whose line counts are honored, so a content line can never be
// taken for a header. Git extended headers are parsed only so their rules can
// apply. Anything else makes the whole patch unreadable.
//
// The result also keeps, per repository, each file's old and new path and the
// raw text of its section: story 4.2 applies exactly what was validated and
// never parses the patch again. patchCheckView drops those internal fields.
import type { RunDownload } from './runs.ts';

export type PatchRule =
  | 'too-large'
  | 'unreadable'
  | 'outside-downloads'
  | 'outside-repository'
  | 'git-internals'
  | 'workflow-file'
  | 'symbolic-link'
  | 'file-mode';

export const PATCH_RULE_MESSAGES: Readonly<Record<PatchRule, string>> = {
  'too-large': 'The patch is larger than the patch size limit, so Debug it cannot open a pull request from it.',
  unreadable: 'The patch cannot be read as a unified diff, so Debug it cannot open a pull request from it.',
  'outside-downloads': 'The patch changes a file outside the repositories downloaded for this run.',
  'outside-repository': 'The patch names a path that is not a file inside its repository.',
  'git-internals': 'The patch changes a file inside a .git folder.',
  'workflow-file': 'Workflow files cannot be changed by Debug it; apply this change to the workflow by hand.',
  'symbolic-link': 'The patch creates, changes or deletes a symbolic link.',
  'file-mode':
    'The patch changes a file mode, or adds a file with a mode other than 100644 (a plain, non-executable file).',
};

export type PatchStatus = 'empty' | 'passed' | 'refused';

/** What the API answers about one repository of the patch. */
export interface PatchRepositoryCheckView {
  repository: string;
  folder: string;
  /** The unique paths inside the repository, in patch order. */
  files: string[];
  status: 'passed' | 'refused';
  rule: PatchRule | null;
  message: string | null;
}

/** One file section of the patch, as validated; paths are inside the repository, null for /dev/null. */
export interface PatchFileSection {
  oldPath: string | null;
  newPath: string | null;
  /** The raw text of the section, headers and hunks. */
  text: string;
}

export interface PatchRepositoryCheck extends PatchRepositoryCheckView {
  sections: PatchFileSection[];
}

/** The internal outcome, kept for story 4.2. */
export interface PatchCheck {
  status: PatchStatus;
  rule: PatchRule | null;
  message: string | null;
  repositories: PatchRepositoryCheck[];
}

/** What GET /debug-it/runs/{runId}/result answers as patchCheck. */
export interface PatchCheckView {
  status: PatchStatus;
  rule: PatchRule | null;
  message: string | null;
  repositories: PatchRepositoryCheckView[];
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u206a-\u206f\ufeff]/g;
/** .git and the names Windows file systems also open as .git (trailing dots or spaces, 8.3 short name). */
const GIT_FOLDER = /^(?:\.git[. ]*|git~\d+)$/;
const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE = '\\ No newline at end of file';
const ALLOWED_MODES: ReadonlySet<string> = new Set(['100644', '100755', '120000']);
const SYMLINK_MODE = '120000';
const NEW_FILE_MODE = '100644';

const EXTENDED: ReadonlyArray<[RegExp, ExtendedKind]> = [
  [/^index [0-9a-f]+\.\.[0-9a-f]+(?: ([0-7]+))?$/, 'index'],
  [/^new file mode ([0-7]+)$/, 'new-file'],
  [/^deleted file mode ([0-7]+)$/, 'deleted-file'],
  [/^old mode ([0-7]+)$/, 'old-mode'],
  [/^new mode ([0-7]+)$/, 'new-mode'],
  [/^similarity index \d+%$/, 'similarity'],
  [/^dissimilarity index \d+%$/, 'similarity'],
  [/^rename from (.*)$/, 'rename-from'],
  [/^rename to (.*)$/, 'rename-to'],
  [/^copy from (.*)$/, 'copy-from'],
  [/^copy to (.*)$/, 'copy-to'],
];

type ExtendedKind =
  | 'index'
  | 'new-file'
  | 'deleted-file'
  | 'old-mode'
  | 'new-mode'
  | 'similarity'
  | 'rename-from'
  | 'rename-to'
  | 'copy-from'
  | 'copy-to';

type Side = 'old' | 'new';

/** One path as written in the patch, with where it came from. */
interface RawPath {
  text: string;
  /** The prefix it must carry: a/ or b/, or none for rename and copy lines. */
  prefix: 'a/' | 'b/' | null;
  side: Side;
  /** Lower rank wins when choosing the section's old and new path. */
  rank: number;
}

interface ParsedSection {
  paths: RawPath[];
  modes: Array<{ kind: ExtendedKind; mode: string }>;
  newFile: boolean;
  deletedFile: boolean;
  /** Set by `new file mode` / `deleted file mode`, to compare with the ---/+++ lines. */
  newFileMode: boolean;
  deletedFileMode: boolean;
  /** Extended header lines read after diff --git. */
  extended: number;
  /** rename from, rename to, copy from, copy to: how many of each. */
  pairs: Record<'rename-from' | 'rename-to' | 'copy-from' | 'copy-to', number>;
  hasFileHeaders: boolean;
  start: number;
  end: number;
}

/** Path text ends at the first tab. */
function pathText(value: string): string {
  const tab = value.indexOf('\t');
  return tab === -1 ? value : value.slice(0, tab);
}

/** `a/P b/Q` from a diff --git line, or null when it cannot be split. */
function splitGitHeader(rest: string): [string, string] | null {
  if (!rest.startsWith('a/')) return null;
  const splits: Array<[string, string]> = [];
  for (let i = rest.indexOf(' b/'); i !== -1; i = rest.indexOf(' b/', i + 1)) {
    splits.push([rest.slice(0, i), rest.slice(i + 1)]);
  }
  if (splits.length === 1) return splits[0]!;
  return splits.find(([a, b]) => a.slice(2) === b.slice(2)) ?? null;
}

/** Hunks from line i; returns the index after them, or -1 when unreadable. */
function readHunks(lines: readonly string[], i: number): number {
  let hunks = 0;
  while (i < lines.length) {
    const match = HUNK.exec(lines[i]!);
    if (match === null) break;
    let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
    let newLeft = match[4] === undefined ? 1 : Number(match[4]);
    if (oldLeft === 0 && newLeft === 0) return -1;
    i += 1;
    // A "\ No newline" marker may only follow a content line.
    let afterContent = false;
    while (oldLeft > 0 || newLeft > 0) {
      const line = lines[i];
      if (line === undefined) return -1;
      const first = line[0];
      if (first === ' ' && oldLeft > 0 && newLeft > 0) {
        oldLeft -= 1;
        newLeft -= 1;
        afterContent = true;
      } else if (first === '-' && oldLeft > 0) {
        oldLeft -= 1;
        afterContent = true;
      } else if (first === '+' && newLeft > 0) {
        newLeft -= 1;
        afterContent = true;
      } else if (afterContent && line.startsWith(NO_NEWLINE)) {
        afterContent = false;
      } else {
        return -1;
      }
      i += 1;
    }
    if (afterContent && i < lines.length && lines[i]!.startsWith(NO_NEWLINE)) i += 1;
    hunks += 1;
  }
  return hunks === 0 ? -1 : i;
}

/** The file sections of a patch, or null when it is unreadable. */
function parseSections(lines: readonly string[]): ParsedSection[] | null {
  const sections: ParsedSection[] = [];
  let i = 0;
  while (i < lines.length) {
    const section: ParsedSection = {
      paths: [],
      modes: [],
      newFile: false,
      deletedFile: false,
      newFileMode: false,
      deletedFileMode: false,
      extended: 0,
      pairs: { 'rename-from': 0, 'rename-to': 0, 'copy-from': 0, 'copy-to': 0 },
      hasFileHeaders: false,
      start: i,
      end: i,
    };
    let line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const split = splitGitHeader(line.slice('diff --git '.length));
      if (split !== null) {
        section.paths.push({ text: split[0], prefix: 'a/', side: 'old', rank: 2 });
        section.paths.push({ text: split[1], prefix: 'b/', side: 'new', rank: 2 });
      }
      i += 1;
      for (; i < lines.length; i += 1) {
        line = lines[i]!;
        const found = EXTENDED.map(([re, kind]) => [re.exec(line), kind] as const).find(([m]) => m !== null);
        if (found === undefined) break;
        const [match, kind] = found;
        const value = match![1];
        section.extended += 1;
        if (kind === 'rename-from' || kind === 'copy-from') {
          section.pairs[kind] += 1;
          section.paths.push({ text: pathText(value!), prefix: null, side: 'old', rank: 0 });
        } else if (kind === 'rename-to' || kind === 'copy-to') {
          section.pairs[kind] += 1;
          section.paths.push({ text: pathText(value!), prefix: null, side: 'new', rank: 0 });
        } else if (kind !== 'similarity' && value !== undefined) {
          section.modes.push({ kind, mode: value });
          if (kind === 'new-file') section.newFile = section.newFileMode = true;
          if (kind === 'deleted-file') section.deletedFile = section.deletedFileMode = true;
        }
      }
      if (i < lines.length && lines[i]!.startsWith('--- ')) {
        i = readFileHeaders(lines, i, section);
        if (i === -1) return null;
      }
      // A diff --git that changes nothing, or half a rename or copy.
      if (section.extended === 0 && !section.hasFileHeaders) return null;
      const { pairs } = section;
      if (pairs['rename-from'] !== pairs['rename-to'] || pairs['copy-from'] !== pairs['copy-to']) return null;
      if (pairs['rename-from'] > 1 || pairs['copy-from'] > 1) return null;
    } else if (line.startsWith('--- ')) {
      i = readFileHeaders(lines, i, section);
      if (i === -1) return null;
    } else {
      return null;
    }
    if (section.paths.length === 0 || !consistent(section)) return null;
    section.end = i;
    sections.push(section);
  }
  return sections;
}

/** `---` and `+++` at line i, then hunks; returns the index after them, or -1. */
function readFileHeaders(lines: readonly string[], i: number, section: ParsedSection): number {
  const oldLine = lines[i]!;
  const newLine = lines[i + 1];
  if (newLine === undefined || !newLine.startsWith('+++ ')) return -1;
  const oldText = pathText(oldLine.slice(4));
  const newText = pathText(newLine.slice(4));
  if (oldText === '/dev/null' && newText === '/dev/null') return -1;
  // new file mode with an old file, or deleted file mode with a new file.
  if (section.newFileMode && oldText !== '/dev/null') return -1;
  if (section.deletedFileMode && newText !== '/dev/null') return -1;
  section.hasFileHeaders = true;
  if (oldText !== '/dev/null') section.paths.push({ text: oldText, prefix: 'a/', side: 'old', rank: 1 });
  else section.newFile = true;
  if (newText !== '/dev/null') section.paths.push({ text: newText, prefix: 'b/', side: 'new', rank: 1 });
  else section.deletedFile = true;
  return readHunks(lines, i + 2);
}

/** The cleaned folder (lower-cased) and path a header line names, to compare header lines. */
function sideKey(raw: RawPath): string {
  const text = raw.prefix !== null && raw.text.startsWith(raw.prefix) ? raw.text.slice(raw.prefix.length) : raw.text;
  const [folder, ...rest] = cleanSegments(text);
  return [folder?.toLowerCase() ?? '', ...rest].join('/');
}

/** Whether every header line of a section names the same old file, and the same new file. */
function consistent(section: ParsedSection): boolean {
  for (const side of ['old', 'new'] as const) {
    const keys = new Set(section.paths.filter((p) => p.side === side).map(sideKey));
    if (keys.size > 1) return false;
  }
  return true;
}

/** Path segments after normalization, case kept. */
function cleanSegments(value: string): string[] {
  const text = value.replace(/\\/g, '/').normalize('NFC').replace(INVISIBLE, '').normalize('NFC');
  return text.split('/').filter((segment) => segment !== '' && segment !== '.');
}

interface CheckedPath {
  /** The lower-cased download folder; null when the path is not in any download. */
  folder: string | null;
  /** The path inside the repository, case kept; null when it names no file inside it. */
  inside: string | null;
  rule: PatchRule | null;
}

function checkPath(raw: RawPath, folders: ReadonlyMap<string, RunDownload>): CheckedPath {
  let text = raw.text;
  let refused: PatchRule | null = null;
  if (CONTROL.test(text)) refused = 'outside-repository';
  if (raw.prefix !== null) {
    if (text.startsWith(raw.prefix)) text = text.slice(raw.prefix.length);
    else refused ??= 'outside-repository';
  }
  if (/^[/\\]/.test(text) || /^[A-Za-z]:/.test(text)) refused ??= 'outside-repository';
  const segments = cleanSegments(text);
  const lower = segments.map((segment) => segment.toLowerCase());
  const folder = lower[0];
  if (folder === undefined || !folders.has(folder)) return { folder: null, inside: null, rule: 'outside-downloads' };
  if (lower.includes('..') || segments.length < 2) refused ??= 'outside-repository';
  if (lower.some((segment) => GIT_FOLDER.test(segment))) refused ??= 'git-internals';
  if (lower.slice(1).join('/').startsWith('.github/workflows')) refused ??= 'workflow-file';
  const inside = segments.length < 2 ? null : segments.slice(1).join('/');
  // The raw text is what gets applied: it must be exactly the path checked (folder case aside).
  const slash = text.indexOf('/');
  const rawInside = slash === -1 ? '' : text.slice(slash + 1);
  if (rawInside !== (inside ?? '')) refused ??= 'outside-repository';
  return { folder, inside, rule: refused };
}

function modeRules(section: ParsedSection): PatchRule[] {
  const rules: PatchRule[] = [];
  for (const { kind, mode } of section.modes) {
    if (mode === SYMLINK_MODE) rules.push('symbolic-link');
    if (!ALLOWED_MODES.has(mode)) rules.push('file-mode');
    if (kind === 'old-mode' || kind === 'new-mode') rules.push('file-mode');
    if (kind === 'new-file' && mode !== NEW_FILE_MODE) rules.push('file-mode');
  }
  return rules;
}

function outcome(status: PatchStatus, rule: PatchRule | null, repositories: PatchRepositoryCheck[]): PatchCheck {
  return { status, rule, message: rule === null ? null : PATCH_RULE_MESSAGES[rule], repositories };
}

/**
 * Validates an untrusted unified diff against the run's downloads. Pure: it
 * never runs git, starts a subprocess, touches the filesystem or logs.
 */
export function validatePatch(patch: string, downloads: readonly RunDownload[], limitBytes: number): PatchCheck {
  const tooLarge = Buffer.byteLength(patch, 'utf8') > limitBytes;
  const lines = patch.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const sections = parseSections(lines);
  if (sections === null) return outcome('refused', tooLarge ? 'too-large' : 'unreadable', []);
  if (sections.length === 0) return tooLarge ? outcome('refused', 'too-large', []) : outcome('empty', null, []);

  const folders = new Map<string, RunDownload>();
  for (const download of downloads) {
    const key = download.folder.toLowerCase();
    if (key !== '' && !folders.has(key)) folders.set(key, download);
  }

  let outsideDownloads = false;
  const repositories = new Map<string, PatchRepositoryCheck>();
  const ownRules = new Map<string, PatchRule>();
  const refuse = (folder: string, rule: PatchRule): void => {
    if (!ownRules.has(folder)) ownRules.set(folder, rule);
  };
  const entry = (folder: string): PatchRepositoryCheck => {
    let repository = repositories.get(folder);
    if (repository === undefined) {
      const download = folders.get(folder)!;
      repository = {
        repository: download.repository,
        folder: download.folder,
        files: [],
        status: 'passed',
        rule: null,
        message: null,
        sections: [],
      };
      repositories.set(folder, repository);
    }
    return repository;
  };

  for (const section of sections) {
    const sectionFolders: string[] = [];
    const best: Record<Side, { rank: number; inside: string | null } | null> = { old: null, new: null };
    for (const raw of section.paths) {
      const checked = checkPath(raw, folders);
      if (checked.folder === null) {
        outsideDownloads = true;
        continue;
      }
      const repository = entry(checked.folder);
      if (!sectionFolders.includes(checked.folder)) sectionFolders.push(checked.folder);
      if (checked.inside !== null && !repository.files.includes(checked.inside)) repository.files.push(checked.inside);
      if (checked.rule !== null) refuse(checked.folder, checked.rule);
      const current = best[raw.side];
      if (current === null || raw.rank < current.rank) best[raw.side] = { rank: raw.rank, inside: checked.inside };
    }
    const sectionRules = modeRules(section);
    if (sectionFolders.length > 1) sectionRules.push('outside-repository');
    for (const folder of sectionFolders) {
      for (const rule of sectionRules) refuse(folder, rule);
      repositories.get(folder)!.sections.push({
        oldPath: section.newFile ? null : (best.old?.inside ?? null),
        newPath: section.deletedFile ? null : (best.new?.inside ?? null),
        text: lines.slice(section.start, section.end).map((line) => `${line}\n`).join(''),
      });
    }
  }

  const wholeRule: PatchRule | null = tooLarge ? 'too-large' : outsideDownloads ? 'outside-downloads' : null;
  let firstRule: PatchRule | null = null;
  for (const [folder, repository] of repositories) {
    const rule = ownRules.get(folder) ?? wholeRule;
    if (rule !== null) {
      repository.status = 'refused';
      repository.rule = rule;
      repository.message = PATCH_RULE_MESSAGES[rule];
      firstRule ??= rule;
    }
  }
  const rule = wholeRule ?? firstRule;
  return outcome(rule === null ? 'passed' : 'refused', rule, [...repositories.values()]);
}

/** The outcome without the internal section paths and text. */
export function patchCheckView(check: PatchCheck): PatchCheckView {
  return {
    status: check.status,
    rule: check.rule,
    message: check.message,
    repositories: check.repositories.map(({ repository, folder, files, status, rule, message }) => ({
      repository,
      folder,
      files: [...files],
      status,
      rule,
      message,
    })),
  };
}
