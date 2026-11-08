// Story 7.4 (SR16): the dashboard attack test in a real browser. Chromium
// (Playwright, pinned in browser/package.json) on the CI runner opens the real
// frontend (nginx with its CSP, port-forwarded from svc/frontend), whose /api/
// goes to the test pod attack-backend, as dana, and opens View debug run for
// the hostile run that leak-backend.ts seeded:
//
//   - the CSP header is on / (default-src 'self', scripts only from self, no
//     outside images or connections);
//   - the explanation shows the literal <script> and <img> text;
//   - window.__attackRan stays undefined (no script ran);
//   - no request goes to a host other than the frontend origin;
//   - PUT /api/debug-it/runs/{id}/feedback without X-CSRF-Token answers 403,
//     with it 2xx.
//
// Every /api/debug-it/ call goes to the real backend. Only the 1.x dashboard
// calls (jobs, runners, scale sets, settings, alerts) are served by page.route
// fixtures, with one failed Recent history row for the hostile run.
//
//   ATTACK_BASE_URL=http://127.0.0.1:<port> ATTACK_COOKIE_FILE=<{"cookie"}> \
//   ATTACK_RUN=<runId> ATTACK_JOB=<jobId> ATTACK_REPO=owner/name ATTACK_OUT=<dir> \
//   node helm/tests/attack/browser-attack.mjs
//
// (ATTACK_CHROMIUM optionally names a local Chromium.) Prints ok/FAIL lines,
// never the cookie or a token; writes browser-output.txt (every printed line
// and the page's console messages) and browser-responses.jsonl (every
// response's status and headers, and the body of every /api/ response; the
// csrfToken field of GET /api/debug-it/session is replaced by a marker when it
// is the csrf of the cookie file, the session's own token) to
// ATTACK_OUT for the leak sweep. Any FAIL exits 1.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = '<script>window.__attackRan=1</script>';
const IMAGE = '<img src="https://attack-outside.example/x.png" onerror="window.__attackRan=1">';
export const JOB_NAME = 'leak-attack-hostile';

/** The invented 1.x dashboard answers, with one failed history row for the hostile run. */
export function dashboardFixtures({ repo, jobId, now = new Date() }) {
  const at = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const runUrl = `https://github.com/${repo}/actions/runs/${jobId + 100000}`;
  const history = [
    {
      id: jobId,
      name: JOB_NAME,
      workflowName: 'CI',
      branch: 'main',
      actor: null,
      event: 'push',
      repository: repo,
      repositoryUrl: `https://github.com/${repo}`,
      result: 'failure',
      runnerName: 'arc-linux-x64-attack',
      scaleSet: 'arc-linux-x64',
      createdAt: at(30),
      startedAt: at(29),
      completedAt: at(27),
      durationMs: 2 * 60_000,
      htmlUrl: `${runUrl}/job/${jobId}`,
      runUrl,
      target: { kind: 'job', id: jobId },
    },
  ];
  const list = { orderingIsEstimate: true, note: '', incomplete: false, items: [] };
  return {
    '/api/jobs/history': history,
    '/api/jobs/queue': list,
    '/api/jobs/running': { ...list, total: 0 },
    '/api/runners': [],
    '/api/scale-sets': [],
    '/api/settings': { runnersRefreshSeconds: 30 },
    '/api/alerts': { evaluatedAt: now.toISOString(), alerts: [] },
  };
}

/** The CSP checks on the / answer: [ok, text] pairs. */
export function cspChecks(csp) {
  const directives = new Map(
    String(csp ?? '')
      .split(';')
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...sources]) => [name.toLowerCase(), sources]),
  );
  const only = (name, allowed) => {
    const sources = directives.get(name) ?? directives.get('default-src') ?? [];
    return sources.length > 0 && sources.every((s) => allowed.includes(s));
  };
  return [
    [csp !== null && csp !== undefined && csp !== '', 'the Content-Security-Policy header is on /'],
    [(directives.get('default-src') ?? []).join(' ') === "'self'", "default-src is 'self'"],
    [only('script-src', ["'self'"]), "scripts only from 'self' (no inline script)"],
    [only('img-src', ["'self'", 'data:']), 'images only from the frontend (and data:)'],
    [only('connect-src', ["'self'"]), "connections only to 'self'"],
  ];
}

export async function main(env = process.env) {
  const out = env.ATTACK_OUT ?? '.';
  mkdirSync(out, { recursive: true });
  const outputFile = join(out, 'browser-output.txt');
  const responsesFile = join(out, 'browser-responses.jsonl');
  writeFileSync(outputFile, '');
  writeFileSync(responsesFile, '');
  let fails = 0;
  const say = (line) => {
    console.log(line);
    appendFileSync(outputFile, `${line}\n`);
  };
  const ok = (text) => say(`ok   - browser: ${text}`);
  const fail = (text) => {
    fails += 1;
    say(`FAIL - browser: ${text}`);
  };

  for (const name of ['ATTACK_BASE_URL', 'ATTACK_COOKIE_FILE', 'ATTACK_RUN', 'ATTACK_JOB', 'ATTACK_REPO']) {
    if (!env[name]) {
      fail(`${name} is not set`);
      return 1;
    }
  }
  const origin = new URL(env.ATTACK_BASE_URL).origin;
  const runId = env.ATTACK_RUN;
  const jobId = Number(env.ATTACK_JOB);
  const repo = env.ATTACK_REPO;
  let cookie;
  let csrf;
  try {
    ({ cookie, csrf } = JSON.parse(readFileSync(env.ATTACK_COOKIE_FILE, 'utf8')));
  } catch {
    cookie = undefined;
  }
  if (typeof cookie !== 'string' || cookie === '') {
    fail('the session cookie file could not be read');
    return 1;
  }

  // 1. The CSP on /, as nginx sends it.
  try {
    const root = await fetch(`${origin}/`, { signal: AbortSignal.timeout(30_000) });
    const headers = Object.fromEntries(root.headers.entries());
    appendFileSync(responsesFile, `${JSON.stringify({ url: '/', status: root.status, headers, body: await root.text() })}\n`);
    for (const [passed, text] of cspChecks(root.headers.get('content-security-policy'))) (passed ? ok : fail)(`CSP: ${text}`);
  } catch (error) {
    fail(`GET / failed (${error?.name ?? 'error'})`);
  }

  const requirePlaywright = createRequire(join(here, 'browser', 'package.json'));
  let chromium;
  try {
    ({ chromium } = requirePlaywright('playwright'));
  } catch {
    fail('playwright not found; run npm ci in helm/tests/attack/browser');
    return 1;
  }
  const browser = await chromium.launch(env.ATTACK_CHROMIUM ? { executablePath: env.ATTACK_CHROMIUM } : {});
  const outside = [];
  const pending = [];
  try {
    const context = await browser.newContext({ baseURL: origin });
    const host = new URL(origin).hostname;
    await context.addCookies([{ name: 'dbg_session', value: cookie, domain: host, path: '/', httpOnly: true, sameSite: 'Lax' }]);
    context.on('request', (request) => {
      const url = new URL(request.url());
      if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.origin !== origin) outside.push(url.host);
    });
    const page = await context.newPage();
    page.on('console', (message) => appendFileSync(outputFile, `console ${message.type()}: ${message.text()}\n`));
    page.on('pageerror', (error) => appendFileSync(outputFile, `pageerror: ${error.message}\n`));
    page.on('response', (response) => {
      pending.push(
        (async () => {
          const url = new URL(response.url());
          const entry = { url: url.pathname, status: response.status(), headers: await response.allHeaders().catch(() => ({})) };
          if (url.origin === origin && url.pathname.startsWith('/api/')) {
            let body = await response.text().catch(() => '');
            if (url.pathname === '/api/debug-it/session') {
              try {
                const json = JSON.parse(body);
                // Only this session's own token (its designed carrier); any other value stays for the sweep.
                if (typeof csrf === 'string' && json.csrfToken === csrf) body = JSON.stringify({ ...json, csrfToken: '[csrf token of this session]' });
              } catch {
                // kept as is
              }
            }
            entry.body = body;
          }
          appendFileSync(responsesFile, `${JSON.stringify(entry)}\n`);
        })(),
      );
    });

    // Only the 1.x dashboard calls; never an /api/debug-it/ call.
    const fixtures = dashboardFixtures({ repo, jobId });
    await page.route(
      (url) => url.origin === origin && url.pathname.startsWith('/api/') && !url.pathname.startsWith('/api/debug-it/'),
      (route) => {
        const path = new URL(route.request().url()).pathname;
        const body = fixtures[path];
        return route.fulfill(
          body === undefined
            ? { status: 404, contentType: 'application/json', body: '{"error":"Not served by the attack test"}' }
            : { status: 200, contentType: 'application/json', body: JSON.stringify(body) },
        );
      },
    );

    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const view = page.getByRole('button', { name: `View debug run: ${JOB_NAME} in ${repo}` });
    try {
      await view.waitFor({ state: 'visible', timeout: 60_000 });
      ok('View debug run shows on the failed Recent history row');
      await view.click();
    } catch {
      fail('View debug run did not show on the failed Recent history row');
    }

    const explanation = page.getByText(SCRIPT, { exact: false }).first();
    try {
      await explanation.waitFor({ state: 'visible', timeout: 60_000 });
      const text = await explanation.textContent();
      if (text?.includes(SCRIPT) && text.includes(IMAGE)) ok('the explanation shows the literal <script> and <img> text');
      else fail('the explanation does not show the literal <script> and <img> text');
    } catch {
      fail('the explanation with the literal <script> text did not show');
    }
    const hostileElements = await page.evaluate(() => ({
      images: [...document.images].filter((i) => i.src.includes('attack-outside')).length,
      scripts: [...document.scripts].filter((s) => s.textContent?.includes('__attackRan')).length,
    }));
    if (hostileElements.images === 0 && hostileElements.scripts === 0) ok('no <img> or <script> element came from the result');
    else fail(`the result became ${hostileElements.images} <img> and ${hostileElements.scripts} <script> elements`);
    await page.waitForTimeout(3000);
    const ran = await page.evaluate(() => typeof window.__attackRan);
    if (ran === 'undefined') ok('window.__attackRan is undefined (no script ran)');
    else fail(`window.__attackRan is ${ran} (a script ran)`);

    // The CSRF check, from the page (same origin, the session cookie goes along).
    const statuses = await page.evaluate(async (id) => {
      const url = `/api/debug-it/runs/${encodeURIComponent(id)}/feedback`;
      const body = JSON.stringify({ rating: 'useful', comment: 'browser attack test' });
      const without = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body });
      const session = await (await fetch('/api/debug-it/session')).json();
      const withToken = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': String(session.csrfToken ?? '') },
        body,
      });
      return { without: without.status, with: withToken.status };
    }, runId);
    if (statuses.without === 403) ok('PUT feedback without X-CSRF-Token answered 403');
    else fail(`PUT feedback without X-CSRF-Token answered ${statuses.without}, expected 403`);
    if (statuses.with >= 200 && statuses.with < 300) ok(`PUT feedback with X-CSRF-Token answered ${statuses.with}`);
    else fail(`PUT feedback with X-CSRF-Token answered ${statuses.with}, expected 2xx`);
    await page.waitForTimeout(1000);
  } catch (error) {
    fail(`the browser test stopped: ${error?.name ?? 'error'}`);
  } finally {
    await Promise.allSettled(pending);
    await browser.close();
  }
  if (outside.length === 0) ok(`no request to a host other than ${origin}`);
  else fail(`${outside.length} requests to other hosts (${[...new Set(outside)].join(', ')})`);
  say(fails === 0 ? 'browser attack test: all ok' : `browser attack test: ${fails} FAIL`);
  return fails === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('browser-attack.mjs')) {
  process.exit(await main());
}
