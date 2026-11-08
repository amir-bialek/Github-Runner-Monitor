// Fake `claude` for the wrapper tests. Usage:
//   node fakeClaude.cjs <capture file> <mode> <claude argv...>
// Records argv (after mode), stdin, cwd and env to the capture file, then acts
// by mode, writing stream-json lines (--output-format stream-json --verbose)
// like Claude Code: a system line, assistant messages, then one result line.
// All names and values are invented.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const [, , captureFile, mode, ...argv] = process.argv;

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function assistant(...content) {
  return line({ type: 'assistant', message: { role: 'assistant', content } });
}

function toolUse(name, n) {
  return { type: 'tool_use', id: `toolu_invented_${name}_${n}`, name, input: {} };
}

function answer(text, extra) {
  return line({ type: 'system', subtype: 'init', tools: ['Read', 'Grep', 'Glob', 'Edit'] }) +
    assistant({ type: 'text', text: 'Looking.' }, toolUse('Read', 1)) +
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_invented_Read_1', content: 'x' }] } }) +
    line({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: text,
      total_cost_usd: 0.4321,
      usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 3, output_tokens: 45 },
      ...extra,
    });
}

const FENCE = '```';
function jsonAnswer(explanation, causeLocation) {
  return `I looked at the log.\n\n${FENCE}json\n${JSON.stringify({ explanation, causeLocation })}\n${FENCE}\n`;
}

function repo(...parts) {
  return path.join(process.cwd(), 'repos', ...parts);
}

function editApp() {
  const file = repo('payments-api', 'src', 'app.ts');
  const text = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, text.replace("const port = '3000';", 'const port = 3000;'));
}

function act() {
  switch (mode) {
    case 'success':
      editApp();
      process.stdout.write(answer(jsonAnswer('The port was a string.', { kind: 'this-repository' })));
      return;
    case 'tools':
      // Every tool name, an unknown one (counted as other), a line that is
      // not JSON, a huge line that is dropped, and a result line with no
      // trailing newline. The tool name and text never reach the wrapper's output.
      editApp();
      process.stdout.write(
        assistant(toolUse('Read', 1), toolUse('Read', 2), toolUse('Grep', 1)) +
          'not json at all\n' +
          assistant({ type: 'text', text: 'invented-claude-text' }, toolUse('Glob', 1), toolUse('Edit', 1)) +
          assistant(toolUse('Bash', 1), toolUse('invented-tool-name', 1)) +
          line({ type: 'assistant', message: { content: 'not a list' } }) +
          line({ type: 'user', message: { content: [toolUse('Bash', 2)] } }) +
          `${'x'.repeat(5 * 1024 * 1024)}\n` +
          answer(jsonAnswer('The port was a string.', { kind: 'this-repository' })).trimEnd(),
      );
      return;
    case 'extra':
      process.stdout.write(answer(jsonAnswer('The shared action pins an old Node.', { kind: 'extra-repository', repository: 'shared-actions' })));
      return;
    case 'prose':
      process.stdout.write(answer('  The runner ran out of disk. Ask the platform team to clean it.  '));
      return;
    case 'plainjson':
      process.stdout.write(answer(JSON.stringify({ explanation: 'Whole text answer.', causeLocation: { kind: 'runner' } })));
      return;
    case 'badcause':
      process.stdout.write(answer(jsonAnswer('Some other repository.', { kind: 'extra-repository', repository: 'not-downloaded' })));
      return;
    case 'noedit':
      process.stdout.write(answer(jsonAnswer('Nothing to fix here. Ask the platform team.', { kind: 'infrastructure' })));
      return;
    case 'adddelete':
      fs.writeFileSync(repo('payments-api', 'src', 'new.ts'), 'export const added = 1;\n');
      fs.unlinkSync(repo('payments-api', 'README.md'));
      process.stdout.write(answer(jsonAnswer('Moved things.', { kind: 'this-repository' })));
      return;
    case 'huge': {
      const lines = [];
      for (let i = 0; i < 12000; i += 1) lines.push(`export const value${i} = 'invented-${i}-xxxxxxxxxxxx';`);
      fs.writeFileSync(repo('payments-api', 'src', 'generated.ts'), `${lines.join('\n')}\n`);
      process.stdout.write(answer(jsonAnswer('Generated a large file.', { kind: 'this-repository' })));
      return;
    }
    case 'budget':
      process.stdout.write(
        answer('', { subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 1.9 }),
      );
      process.exitCode = 1;
      return;
    case 'error':
      process.stdout.write('this is not json {');
      process.exitCode = 1;
      return;
    case 'iserror':
      process.stdout.write(answer('Partial thoughts.', { is_error: true }));
      return;
    case 'sleep':
      editApp();
      setInterval(() => {}, 1000);
      return;
    case 'stubborn':
      editApp();
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      return;
    case 'leak': {
      const log = fs.readFileSync(path.join(process.cwd(), 'log.txt'), 'utf8');
      const everything = `${stdin}\n${log}\n${JSON.stringify(process.env)}\n`;
      process.stdout.write(everything);
      process.stderr.write(everything);
      return;
    }
    default:
      process.exitCode = 3;
  }
}

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  fs.writeFileSync(captureFile, JSON.stringify({ argv, stdin, cwd: process.cwd(), env: process.env }));
  act();
});
