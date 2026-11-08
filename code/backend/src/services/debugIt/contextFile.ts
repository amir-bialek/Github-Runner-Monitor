// The debug context file (FR26, FR27, FR7): a repository opts in to Debug it
// with .github/claude-debug-context.md on its default branch. This module
// parses its three sections and its extra repositories, and turns a missing,
// empty or oversized file into a one-sentence refusal the start checks show.
// It holds no GitHub code: the githubApp adapter reads the file.
import { CONTEXT_FILE_MAX_BYTES, CONTEXT_FILE_PATH, type GitHubApp } from '../../adapters/githubApp.ts';

/** Most extra repositories one run downloads. */
export const MAX_EXTRA_REPOSITORIES = 5;
/** Longest entry text kept on a skipped repository. */
export const SKIPPED_ENTRY_MAX_CHARS = 200;

export type SkipReason = 'invalid-name' | 'outside-organization' | 'over-limit';

export interface DebugContext {
  aboutThisRepo: string;
  commonFailures: string;
  /** Kept entries as `{organization}/{name}`, in file order, at most 5. */
  extraRepositories: string[];
  skippedRepositories: Array<{ entry: string; reason: SkipReason }>;
}

export type ContextFileOutcome = { ok: true; context: DebugContext } | { ok: false; reason: string };

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

const ABOUT = 'about this repo';
const FAILURES = 'common failures';
const EXTRAS = 'extra repositories';

interface Line {
  /** The line with HTML comments removed (fenced lines are kept as written). */
  text: string;
  /** Heading level 1 to 6, or 0 when the line is not a heading. */
  level: number;
  /** The heading text, trimmed, lowercase, trailing #s removed. */
  title: string;
  /** Inside a code fence, fence lines included. */
  fenced: boolean;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// Splits the file into lines, drops HTML comments outside code fences and
// marks ATX headings outside code fences.
function scan(text: string): Line[] {
  const lines: Line[] = [];
  let fence: string | undefined;
  let inComment = false;
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    if (fence) {
      const close = FENCE.exec(raw);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length) fence = undefined;
      lines.push({ text: raw, level: 0, title: '', fenced: true });
      continue;
    }
    const startedInComment = inComment;
    let rest = raw;
    let kept = '';
    for (;;) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end < 0) break;
        rest = rest.slice(end + 3);
        inComment = false;
      } else {
        const start = rest.indexOf('<!--');
        if (start < 0) {
          kept += rest;
          break;
        }
        kept += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inComment = true;
      }
    }
    const fenceMatch = startedInComment ? null : FENCE.exec(kept);
    if (fenceMatch) {
      fence = fenceMatch[1];
      lines.push({ text: raw, level: 0, title: '', fenced: true });
      continue;
    }
    const heading = HEADING.exec(kept);
    if (!heading) {
      lines.push({ text: kept, level: 0, title: '', fenced: false });
      continue;
    }
    // A closing run of #s is dropped when a space precedes it, or when it is all there is.
    let title = heading[2] ?? '';
    title = /^#+$/.test(title) ? '' : title.replace(/[ \t]+#+$/, '');
    lines.push({ text: kept, level: heading[1]!.length, title: title.trim().toLowerCase(), fenced: false });
  }
  return lines;
}

// The lines under the first heading titled `title`, up to the next heading of
// the same or a higher level; undefined when no heading has that title.
function sectionLines(lines: Line[], title: string): Line[] | undefined {
  const start = lines.findIndex((line) => line.level > 0 && line.title === title);
  if (start < 0) return undefined;
  const level = lines[start]!.level;
  let end = start + 1;
  while (end < lines.length && !(lines[end]!.level > 0 && lines[end]!.level <= level)) end += 1;
  return lines.slice(start + 1, end);
}

function body(lines: Line[] | undefined): string {
  return lines ? lines.map((line) => line.text).join('\n').trim() : '';
}

const LIST_ITEM = /^ {0,3}[-*+](?:[ \t]+(.*))?$/;

// The first token of each list item directly in the section: top level items
// before any nested heading, outside code fences.
function listEntries(lines: Line[] | undefined): string[] {
  if (!lines) return [];
  const entries: string[] = [];
  for (const line of lines) {
    if (line.level > 0) break;
    if (line.fenced) continue;
    const item = LIST_ITEM.exec(line.text);
    if (!item) continue;
    const token = (item[1] ?? '').trim().split(/\s+/)[0] ?? '';
    const entry = token.replace(/^`+/, '').replace(/`+$/, '');
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Parses a debug context file. `repository` is the failing repository
 * (owner/name), which is never listed as an extra repository.
 */
export function parseContextFile(text: string, options: { organization: string; repository: string }): DebugContext {
  const lines = scan(text);
  const organization = options.organization;
  const self = options.repository.toLowerCase();
  const seen = new Set<string>();
  const extraRepositories: string[] = [];
  const skippedRepositories: DebugContext['skippedRepositories'] = [];
  const skip = (entry: string, reason: SkipReason) =>
    skippedRepositories.push({ entry: Array.from(entry).slice(0, SKIPPED_ENTRY_MAX_CHARS).join(''), reason });

  for (const entry of listEntries(sectionLines(lines, EXTRAS))) {
    const parts = entry.split('/');
    const owner = parts.length === 2 ? parts[0]! : organization;
    const name = parts.length === 2 ? parts[1]! : parts[0]!;
    if (parts.length > 2 || !OWNER.test(owner) || !NAME.test(name)) {
      skip(entry, 'invalid-name');
      continue;
    }
    const key = `${owner}/${name}`.toLowerCase();
    if (key === self || seen.has(key)) continue;
    seen.add(key);
    if (owner.toLowerCase() !== organization.toLowerCase()) {
      skip(entry, 'outside-organization');
      continue;
    }
    if (extraRepositories.length >= MAX_EXTRA_REPOSITORIES) {
      skip(entry, 'over-limit');
      continue;
    }
    extraRepositories.push(`${organization}/${name}`);
  }

  return {
    aboutThisRepo: body(sectionLines(lines, ABOUT)),
    commonFailures: body(sectionLines(lines, FAILURES)),
    extraRepositories,
    skippedRepositories,
  };
}

/**
 * Reads and parses the debug context file of `repository`. A missing, empty
 * or oversized file is a refusal with a one-sentence reason; GitHub failures
 * surface as the adapter's GitHubAppError.
 */
export async function loadContextFile(
  app: Pick<GitHubApp, 'readContextFile'>,
  repository: string,
  organization: string,
): Promise<ContextFileOutcome> {
  const answer = await app.readContextFile(repository);
  if (answer.status === 'missing') {
    return {
      ok: false,
      reason: `${repository} has no debug context file at ${CONTEXT_FILE_PATH} on its default branch.`,
    };
  }
  if (answer.status === 'too-large') {
    return {
      ok: false,
      reason: `In ${repository}, the debug context file at ${CONTEXT_FILE_PATH} is larger than ${CONTEXT_FILE_MAX_BYTES / 1024} KiB.`,
    };
  }
  if (answer.text.trim() === '') {
    return {
      ok: false,
      reason: `${repository} has an empty debug context file at ${CONTEXT_FILE_PATH} on its default branch.`,
    };
  }
  return { ok: true, context: parseContextFile(answer.text, { organization, repository }) };
}
