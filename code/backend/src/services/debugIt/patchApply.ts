// Applies one validated file section of a patch to the original file text
// (story 4.2). Pure and exact: no git, no subprocess, no filesystem, no fuzz.
// The section was already validated by patchValidation.ts (story 4.1); this
// reads only its file headers (to know a new or deleted file) and its `@@`
// hunks. Each hunk applies at its stated line: the context and removed lines
// must equal the original lines there, or the section does not apply.
//
// Lines are split on "\n" only, so a "\r" stays part of its line on both
// sides and CRLF files compare exactly. `\ No newline at end of file` is
// honored on both sides.

export class PatchApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatchApplyError';
  }
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NO_NEWLINE = '\\ No newline at end of file';

/** One line of a file and whether a newline ends it. */
interface Line {
  text: string;
  newline: boolean;
}

function splitFile(text: string): Line[] {
  if (text === '') return [];
  const parts = text.split('\n');
  const last = parts.pop()!;
  const lines = parts.map((part) => ({ text: part, newline: true }));
  if (last !== '') lines.push({ text: last, newline: false });
  return lines;
}

function joinFile(lines: readonly Line[]): string {
  return lines.map((line) => line.text + (line.newline ? '\n' : '')).join('');
}

function sectionLines(sectionText: string): string[] {
  const lines = sectionText.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Whether the section is a git copy: its source path stays. */
export function isCopySection(sectionText: string): boolean {
  for (const line of sectionLines(sectionText)) {
    if (HUNK.test(line) || line.startsWith('--- ')) return false;
    if (line.startsWith('copy from ')) return true;
  }
  return false;
}

/**
 * The new text of the file after the section, or null when the section
 * deletes it. `original` is the file at the failed commit, or null when it
 * does not exist there. Throws a PatchApplyError when the section does not
 * apply exactly.
 */
export function applySection(original: string | null, sectionText: string): string | null {
  const lines = sectionLines(sectionText);
  let isNew = false;
  let isDeleted = false;
  let i = 0;
  // File headers, up to the first hunk.
  for (; i < lines.length && !HUNK.test(lines[i]!); i += 1) {
    const line = lines[i]!;
    if (line.startsWith('new file mode ')) isNew = true;
    else if (line.startsWith('deleted file mode ')) isDeleted = true;
    else if (line.startsWith('--- ') && /^--- \/dev\/null(?:\t|$)/.test(line)) isNew = true;
    else if (line.startsWith('+++ ') && /^\+\+\+ \/dev\/null(?:\t|$)/.test(line)) isDeleted = true;
  }
  if (isNew && isDeleted) throw new PatchApplyError('The section both adds and deletes the file.');
  if (isNew && original !== null) throw new PatchApplyError('The new file already exists.');
  if (!isNew && original === null) throw new PatchApplyError('The changed file does not exist.');

  const source = splitFile(original ?? '');
  const out: Line[] = [];
  let cursor = 0;

  while (i < lines.length) {
    const match = HUNK.exec(lines[i]!);
    if (match === null) throw new PatchApplyError('The section has text outside its hunks.');
    const oldStart = Number(match[1]);
    let oldLeft = match[2] === undefined ? 1 : Number(match[2]);
    let newLeft = match[4] === undefined ? 1 : Number(match[4]);
    // With no old lines, the hunk goes after line oldStart.
    const at = oldLeft === 0 ? oldStart : oldStart - 1;
    if (at < 0 || at < cursor || at > source.length) throw new PatchApplyError('A hunk starts at a line that is not there.');
    while (cursor < at) out.push({ ...source[cursor++]! });
    i += 1;
    // The source line (old side) and output line (new side) the last content line touched.
    let lastOld: Line | null = null;
    let lastNew: Line | null = null;
    let lastOldIndex = -1;
    while (oldLeft > 0 || newLeft > 0 || (i < lines.length && lines[i]!.startsWith(NO_NEWLINE))) {
      const line = lines[i];
      if (line === undefined) throw new PatchApplyError('A hunk ends early.');
      i += 1;
      if (line.startsWith(NO_NEWLINE)) {
        if (lastOld === null && lastNew === null) throw new PatchApplyError('A no newline marker follows no line.');
        if (lastOld !== null) {
          if (lastOldIndex !== source.length - 1 || lastOld.newline) {
            throw new PatchApplyError('The original file ends differently.');
          }
          lastOld = null;
        }
        if (lastNew !== null) {
          lastNew.newline = false;
          lastNew = null;
        }
        continue;
      }
      const kind = line[0];
      const text = line.slice(1);
      if (kind === ' ' || kind === '-') {
        if (oldLeft === 0 || (kind === ' ' && newLeft === 0)) throw new PatchApplyError('A hunk has more lines than it says.');
        const current = source[cursor];
        if (current === undefined || current.text !== text) throw new PatchApplyError('The original file differs.');
        // A last line without newline must be marked as such in the hunk.
        if (!current.newline) {
          const next = lines[i];
          if (next === undefined || !next.startsWith(NO_NEWLINE)) throw new PatchApplyError('The original file ends differently.');
        }
        lastOld = current;
        lastOldIndex = cursor;
        cursor += 1;
        oldLeft -= 1;
        if (kind === ' ') {
          const copied = { text, newline: true };
          out.push(copied);
          lastNew = copied;
          newLeft -= 1;
        } else {
          lastNew = null;
        }
      } else if (kind === '+') {
        if (newLeft === 0) throw new PatchApplyError('A hunk has more lines than it says.');
        const added = { text, newline: true };
        out.push(added);
        lastNew = added;
        lastOld = null;
        newLeft -= 1;
      } else {
        throw new PatchApplyError('A hunk has a line that is not context, removed or added.');
      }
    }
  }
  while (cursor < source.length) out.push({ ...source[cursor++]! });
  // Only the last line may lack its newline.
  if (out.slice(0, -1).some((line) => !line.newline)) throw new PatchApplyError('A line in the middle of the file lacks its newline.');
  const result = joinFile(out);
  if (isDeleted) {
    if (result !== '') throw new PatchApplyError('The deleted file holds more than the section removes.');
    return null;
  }
  return result;
}
