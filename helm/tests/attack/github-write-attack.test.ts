// Story 7.3: the GitHub write attack test against a local fake GitHub. The
// honest fake gives zero FAILs; a fake that lets the merge or the push
// through, has no ruleset on ATTACK_TEST_REPO or hands out a token covering
// two repositories each gives a FAIL; a missing or malformed secret fails;
// no fake token or key appears in the output.
//
//   cd code/backend && npm ci     (once: the backend runs under tsx)
//   node --test helm/tests/attack/github-write-attack.test.ts
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { ENV, fakeGitHub, OTHER, REPO, type FakeOptions } from './fake-github.ts';
import { checkSecrets, runGitHubWriteAttack } from './github-write-attack.ts';


async function run(options: FakeOptions = {}, env: Record<string, string | undefined> = ENV) {
  const fake = fakeGitHub(options);
  await new Promise<void>((done) => fake.server.listen(0, '127.0.0.1', done));
  const apiBase = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  const lines: string[] = [];
  try {
    const fails = await runGitHubWriteAttack({ env, apiBase, auth: fake.auth, log: (line) => lines.push(line) });
    return { fails, lines, fake };
  } finally {
    fake.server.closeAllConnections();
    await new Promise((done) => fake.server.close(done));
  }
}

const failLines = (lines: string[]) => lines.filter((l) => l.startsWith('FAIL'));

describe('github write attack test', () => {
  it('the honest fake: every row ok, zero FAILs, cleanup done, no write to the no-ruleset repository', async () => {
    const { fails, lines, fake } = await run();
    assert.deepEqual(failLines(lines), [], lines.join('\n'));
    assert.equal(fails, 0);
    for (const row of ['open-a-pr', 'push', 'merge', 'no ruleset', 'patch rule', 'tokens']) {
      assert.ok(lines.some((l) => l.startsWith(`ok   - ${row}`)), `${row} printed ok`);
    }
    assert.equal(lines.filter((l) => l.startsWith('ok   - patch rule')).length, 12);
    assert.ok(lines.some((l) => l.startsWith('cleanup - closed pull request #1')));
    assert.ok(lines.some((l) => l.startsWith('cleanup - deleted branch')));
    const repo = fake.repos.get(REPO.toLowerCase())!;
    assert.equal(repo.pulls[0]!.state, 'closed');
    assert.deepEqual([...repo.refs.keys()], ['main']);
    const otherWrites = fake.seen.filter((s) => !s.startsWith('GET') && s.includes(`/repos/${OTHER}`));
    assert.deepEqual(otherWrites, []);
  });

  it('no fake token or key appears in the output', async () => {
    const { lines, fake } = await run();
    const output = lines.join('\n');
    assert.ok(fake.tokens.size > 0);
    for (const token of fake.tokens.keys()) assert.ok(!output.includes(token), 'token printed');
    assert.ok(!output.includes('ghs_fake_'));
    assert.ok(!output.includes('jwt_fake_'));
    assert.ok(!output.includes('FAKEPRIVATEKEY'));
  });

  it('a merge that goes through fails', async () => {
    const { fails, lines } = await run({ allowMerge: true });
    assert.ok(fails > 0);
    assert.ok(failLines(lines).some((l) => l.includes('merge:')), lines.join('\n'));
  });

  it('a push that goes through fails', async () => {
    const { fails, lines } = await run({ allowPush: true });
    assert.ok(fails > 0);
    assert.ok(failLines(lines).some((l) => l.includes('push:')), lines.join('\n'));
  });

  it('no ruleset on ATTACK_TEST_REPO fails', async () => {
    const { fails, lines } = await run({ noRuleset: true });
    assert.ok(fails > 0);
    assert.ok(failLines(lines).some((l) => l.includes('open-a-pr:') && l.includes('409')), lines.join('\n'));
  });

  it('a token covering two repositories fails', async () => {
    const { fails, lines } = await run({ wideTokens: true });
    assert.ok(fails > 0);
    assert.ok(failLines(lines).some((l) => l.startsWith('FAIL - tokens:') && l.includes('2 repositories')), lines.join('\n'));
  });

  for (const name of Object.keys(ENV)) {
    it(`a missing ${name} fails`, async () => {
      const { fails, lines, fake } = await run({}, { ...ENV, [name]: '' });
      assert.equal(fails, 1);
      assert.deepEqual(lines, [`FAIL - ${name} is not set`]);
      assert.deepEqual(fake.seen, []);
    });
  }

  it('malformed repositories fail with one line', () => {
    assert.equal(checkSecrets({ ...ENV, ATTACK_TEST_REPO: 'payments-api' }), 'FAIL - ATTACK_TEST_REPO is not owner/name');
    assert.equal(checkSecrets({ ...ENV, ATTACK_TEST_REPO_NO_RULESET: 'a/b/c' }), 'FAIL - ATTACK_TEST_REPO_NO_RULESET is not owner/name');
    assert.equal(
      checkSecrets({ ...ENV, ATTACK_TEST_REPO_NO_RULESET: 'globex/billing-api' }),
      'FAIL - ATTACK_TEST_REPO_NO_RULESET must have the same owner as ATTACK_TEST_REPO',
    );
    assert.equal(
      checkSecrets({ ...ENV, ATTACK_TEST_REPO_NO_RULESET: REPO.toUpperCase() }),
      'FAIL - ATTACK_TEST_REPO_NO_RULESET must be another repository than ATTACK_TEST_REPO',
    );
    assert.equal(checkSecrets(ENV), null);
  });
});
