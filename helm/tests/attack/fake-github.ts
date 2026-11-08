// Stories 7.3 and 7.4: a local fake GitHub for the attack test unit tests:
// two repositories of an invented owner (one with a ruleset on main), the Git
// Data API, pulls, merges, rulesets, installation repositories and a fake App
// auth whose tokens cover the repositories they name. Options make it
// dishonest (let a merge or push through, no ruleset, tokens for two
// repositories).
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// Invented names only.
export const OWNER = 'acme-attack';
export const REPO = `${OWNER}/payments-api`;
export const OTHER = `${OWNER}/billing-api`;
// Invented, not a key: the PEM markers are built from parts so secret scanners
// do not take the fixture for a private key.
const PEM = ['RSA', 'PRIVATE', 'KEY'].join(' ');
export const KEY = `-----BEGIN ${PEM}-----\nFAKEPRIVATEKEYLINEFORTHEATTACKTESTONLY0123456789\n-----END ${PEM}-----\n`;
export const ENV = {
  ATTACK_TEST_GITHUB_APP_ID: '424242',
  ATTACK_TEST_GITHUB_APP_PRIVATE_KEY: KEY,
  ATTACK_TEST_REPO: REPO,
  ATTACK_TEST_REPO_NO_RULESET: OTHER,
};

export interface FakeOptions {
  allowMerge?: boolean;
  allowPush?: boolean;
  noRuleset?: boolean;
  wideTokens?: boolean;
}

const sha = (text: string): string => createHash('sha1').update(text).digest('hex');

interface Repo {
  fullName: string;
  protected: boolean;
  refs: Map<string, string>;
  commits: Map<string, { tree: string }>;
  trees: Map<string, Array<Record<string, unknown>>>;
  pulls: Array<{ number: number; head: string; headSha: string; base: string; draft: boolean; state: string }>;
}

export function fakeGitHub(options: FakeOptions = {}) {
  let counter = 0;
  const tokens = new Map<string, string[]>();
  const repos = new Map<string, Repo>();
  for (const [fullName, isProtected] of [
    [REPO, !options.noRuleset],
    [OTHER, false],
  ] as const) {
    const tree = sha(`${fullName}-tree`);
    const head = sha(`${fullName}-head`);
    repos.set(fullName.toLowerCase(), {
      fullName,
      protected: isProtected,
      refs: new Map([['main', head]]),
      commits: new Map([[head, { tree }]]),
      trees: new Map([[tree, [{ path: 'README.md', mode: '100644', type: 'blob', sha: sha('readme') }]]]),
      pulls: [],
    });
  }

  const auth = async (authOptions: Record<string, unknown>) => {
    counter += 1;
    if (authOptions.type === 'app') return { token: `jwt_fake_${counter}` };
    const names = options.wideTokens
      ? [REPO, OTHER]
      : ((authOptions.repositoryNames as string[] | undefined) ?? ['payments-api', 'billing-api']).map((n) => `${OWNER}/${n}`);
    const token = `ghs_fake_${counter}_${'x'.repeat(20)}`;
    tokens.set(token, names);
    return { token };
  };

  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const body = raw ? JSON.parse(raw) : {};
      const url = new URL(req.url!, 'http://fake');
      const path = decodeURIComponent(url.pathname);
      const method = req.method!;
      seen.push(`${method} ${path}`);
      const auth = String(req.headers.authorization ?? '').split(' ')[1] ?? '';

      if (method === 'POST' && path === '/graphql') {
        // markPullRequestReadyForReview: the node ID is pr-<repo>-<number>.
        const id = String(body.variables?.id ?? '');
        const repoOf = [...repos.values()].find((r) => id.startsWith(`pr-${r.fullName}-`));
        const pull = repoOf?.pulls.find((p) => id === `pr-${repoOf.fullName}-${p.number}`);
        if (!repoOf || !pull || !(tokens.get(auth) ?? []).includes(repoOf.fullName)) {
          return send(200, { errors: [{ message: 'Could not resolve to a node' }] });
        }
        pull.draft = false;
        return send(200, { data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
      }
      if (method === 'GET' && path === '/installation/repositories') {
        const names = tokens.get(auth);
        if (!names) return send(401);
        return send(200, { total_count: names.length, repositories: names.map((n) => ({ full_name: n })) });
      }
      const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
      if (!m) return send(404);
      const repo = repos.get(m[1]!.toLowerCase());
      if (!repo) return send(404);
      const rest = m[2] ?? '';
      if (rest === '/installation') return auth.startsWith('jwt_fake_') ? send(200, { id: 77, permissions: {} }) : send(401);
      if (!(tokens.get(auth) ?? []).some((n) => n.toLowerCase() === repo.fullName.toLowerCase())) return send(404);

      const moveDefault = (to: string) => {
        repo.refs.set('main', to);
      };
      if (method === 'GET' && rest === '') return send(200, { full_name: repo.fullName, default_branch: 'main' });
      if (method === 'GET' && rest === '/rules/branches/main') {
        return send(200, repo.protected ? [{ type: 'pull_request', ruleset_id: 5, parameters: { required_approving_review_count: 2 } }] : []);
      }
      if (method === 'GET' && rest === '/rulesets/5') return send(200, { id: 5, enforcement: 'active', current_user_can_bypass: 'never' });
      let r = /^\/git\/ref\/heads\/(.+)$/.exec(rest);
      if (method === 'GET' && r) {
        const at = repo.refs.get(r[1]!);
        return at ? send(200, { ref: `refs/heads/${r[1]}`, object: { sha: at } }) : send(404);
      }
      r = /^\/git\/matching-refs\/heads\/(.+)$/.exec(rest);
      if (method === 'GET' && r) {
        return send(200, [...repo.refs.keys()].filter((k) => k.startsWith(r![1]!)).map((k) => ({ ref: `refs/heads/${k}` })));
      }
      r = /^\/git\/commits\/([0-9a-f]{40})$/.exec(rest);
      if (method === 'GET' && r) {
        const commit = repo.commits.get(r[1]!);
        return commit ? send(200, { sha: r[1], tree: { sha: commit.tree } }) : send(404);
      }
      r = /^\/git\/trees\/([0-9a-f]{40})$/.exec(rest);
      if (method === 'GET' && r) {
        const tree = repo.trees.get(r[1]!);
        return tree ? send(200, { sha: r[1], tree, truncated: false }) : send(404);
      }
      if (method === 'POST' && rest === '/git/blobs') return send(201, { sha: sha(`blob-${raw}`) });
      if (method === 'POST' && rest === '/git/trees') return send(201, { sha: sha(`tree-${raw}`) });
      if (method === 'POST' && rest === '/git/commits') {
        const s = sha(`commit-${raw}`);
        repo.commits.set(s, { tree: body.tree });
        return send(201, { sha: s });
      }
      if (method === 'POST' && rest === '/git/refs') {
        const branch = String(body.ref).replace(/^refs\/heads\//, '');
        if (repo.refs.has(branch)) return send(422);
        if (branch === 'main' && repo.protected) return send(422);
        repo.refs.set(branch, body.sha);
        return send(201, { ref: body.ref, object: { sha: body.sha } });
      }
      r = /^\/git\/refs\/heads\/(.+)$/.exec(rest);
      if (method === 'PATCH' && r) {
        if (r[1] === 'main' && repo.protected && !options.allowPush) return send(422, { message: 'Repository rule violations found' });
        if (!repo.refs.has(r[1]!)) return send(422);
        repo.refs.set(r[1]!, body.sha);
        return send(200, { object: { sha: body.sha } });
      }
      if (method === 'DELETE' && r) {
        return repo.refs.delete(r[1]!) ? send(204) : send(422);
      }
      if (method === 'PUT' && rest.startsWith('/contents/')) {
        if (body.branch === 'main' && repo.protected && !options.allowPush) return send(409, { message: 'Repository rule violations found' });
        const s = sha(`put-${raw}`);
        repo.refs.set(body.branch ?? 'main', s);
        return send(201, { commit: { sha: s } });
      }
      const pullOf = (p: Repo['pulls'][number]) => ({
        number: p.number,
        node_id: `pr-${repo.fullName}-${p.number}`,
        html_url: `https://github.com/${repo.fullName}/pull/${p.number}`,
        draft: p.draft,
        state: p.state,
        head: { ref: p.head, sha: p.headSha },
        base: { ref: p.base },
      });
      if (method === 'GET' && rest === '/pulls') {
        const head = url.searchParams.get('head') ?? '';
        const branch = head.includes(':') ? head.split(':')[1] : head;
        return send(200, repo.pulls.filter((p) => p.state === 'open' && p.head === branch).map(pullOf));
      }
      if (method === 'POST' && rest === '/pulls') {
        if (!repo.refs.has(body.head)) return send(422);
        const pull = { number: repo.pulls.length + 1, head: body.head, headSha: repo.refs.get(body.head)!, base: body.base, draft: body.draft === true, state: 'open' };
        repo.pulls.push(pull);
        return send(201, pullOf(pull));
      }
      r = /^\/pulls\/(\d+)(\/merge)?$/.exec(rest);
      if (r) {
        const pull = repo.pulls.find((p) => p.number === Number(r![1]));
        if (!pull) return send(404);
        if (method === 'GET' && !r[2]) return send(200, pullOf(pull));
        if (method === 'PATCH' && !r[2]) {
          pull.state = body.state ?? pull.state;
          return send(200, pullOf(pull));
        }
        if (method === 'PUT' && r[2]) {
          if (pull.draft) return send(405, { message: 'Pull Request is still a draft' });
          if (repo.protected && !options.allowMerge) return send(405, { message: 'Repository rule violations found' });
          moveDefault(pull.headSha);
          return send(200, { merged: true });
        }
      }
      if (method === 'POST' && rest === '/merges') {
        if (repo.protected && !options.allowMerge) return send(409, { message: 'Repository rule violations found' });
        const head = repo.refs.get(body.head);
        if (!head) return send(404);
        moveDefault(sha(`merge-${head}`));
        return send(201, { sha: repo.refs.get('main') });
      }
      return send(404);
    });
  });
  return { server, auth, repos, seen, tokens };
}
