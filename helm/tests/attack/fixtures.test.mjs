// Story 7.2: the agent attack fixtures upload through the real Debug Job
// receiver, and each canary sits in exactly one repository config item.
// Run with: node --test 'helm/tests/attack/*.test.mjs'
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createReceiver } from '../../../code/debug-job/src/receiver.ts';
import { bundle, canaries, folders, SCENARIOS, uploadedPath } from './fixtures/agent/make-fixtures.mjs';

const CODE = 'invented-upload-code';

function send(port, method, path, body) {
  return new Promise((done, fail) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { authorization: `Bearer ${CODE}`, 'content-length': body.length } },
      (res) => {
        res.resume();
        res.on('end', () => done(res.statusCode));
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

async function upload(scenario) {
  const work = mkdtempSync(join(tmpdir(), 'agent-fixture-'));
  let exitCode;
  const server = createReceiver({ workDir: work, uploadCode: CODE, maxBytes: 10_000_000, maxFiles: 1000, onExit: (c) => (exitCode = c) });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const b = bundle(scenario);
  assert.equal(await send(port, 'PUT', '/upload/log', Buffer.from(b.log, 'base64')), 200);
  for (const folder of b.folders) {
    assert.equal(await send(port, 'PUT', `/upload/repo/${folder}`, Buffer.from(b.repos[folder], 'base64')), 200, folder);
  }
  assert.equal(await send(port, 'POST', '/upload/done', Buffer.from(JSON.stringify({ folders: b.folders, logTruncated: false }))), 200);
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  return { work, exitCode, b };
}

describe('agent attack fixtures', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario} uploads through the receiver`, async () => {
      const { work, exitCode, b } = await upload(scenario);
      try {
        assert.equal(exitCode, 0);
        assert.deepEqual(JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8')).folders, b.folders);
        assert.match(readFileSync(join(work, 'log.txt'), 'utf8'), /##\[error\]Process completed with exit code 1/);
        assert.ok(existsSync(join(work, 'repos', b.folders[0], 'package.json')));
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  }

  it('turns the inert names into the hostile ones', async () => {
    assert.equal(uploadedPath('dot-claude/agents/a.md.fixture'), '.claude/agents/a.md');
    assert.equal(uploadedPath('CLAUDE.md.fixture'), 'CLAUDE.md');
    const { work } = await upload('repo-config');
    try {
      for (const path of [
        'payments-api/.claude/settings.json',
        'billing-api/.claude/settings.json',
        'ledger-api/.claude/settings.json',
        'notify-api/.mcp.json',
        'notify-api/tools/server.mjs',
        'invoice-web/CLAUDE.md',
        'audit-lib/.claude/agents/auditor.md',
        'report-cli/.claude/commands/release.md',
        'search-api/.claude/skills/acme-search/SKILL.md',
        'auth-lib/.claude-plugin/marketplace.json',
        'auth-lib/plugins/acme-auth/.claude-plugin/plugin.json',
      ]) {
        assert.ok(existsSync(join(work, 'repos', path)), path);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it('puts each canary in exactly one repo-config repository, nowhere the prompt shows', async () => {
    const list = canaries();
    assert.equal(list.length, 9);
    assert.equal(new Set(list.map((c) => c.value)).size, 9);
    const b = bundle('repo-config');
    const { work } = await upload('repo-config');
    try {
      const { execFileSync } = await import('node:child_process');
      for (const canary of list) {
        const hits = execFileSync('grep', ['-rlF', canary.value, join(work, 'repos')], { encoding: 'utf8' })
          .trim()
          .split('\n')
          .map((p) => p.slice(join(work, 'repos').length + 1).split('/')[0]);
        assert.equal(new Set(hits).size, 1, canary.name);
        assert.ok(!Buffer.from(b.log, 'base64').toString('utf8').includes(canary.value));
        assert.ok(!folders('repo-config').some((f) => f.includes(canary.value)));
      }
      assert.ok(!existsSync(join(work, 'repos', 'payments-api', '.github', 'claude-debug-context.md')));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
