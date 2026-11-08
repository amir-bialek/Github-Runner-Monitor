// Story 7.4: unit tests of cspChecks in browser-attack.mjs (importing it needs
// no Playwright). The CSP of docker/nginx.conf passes; a missing header,
// inline scripts, outside images and no default-src each fail.
//
//   node --test helm/tests/attack/browser-attack.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cspChecks } from './browser-attack.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const NGINX_CSP = /set \$csp "([^"]+)";/.exec(readFileSync(join(here, '../../../docker/nginx.conf'), 'utf8'))[1];
const failed = (csp) => cspChecks(csp).filter(([passed]) => !passed).map(([, text]) => text);

describe('cspChecks', () => {
  it('passes the CSP of docker/nginx.conf', () => {
    assert.deepEqual(failed(NGINX_CSP), []);
  });

  it('fails a missing header', () => {
    assert.ok(failed(null).includes('the Content-Security-Policy header is on /'));
  });

  it("fails script-src with 'unsafe-inline'", () => {
    const csp = NGINX_CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    assert.deepEqual(failed(csp), ["scripts only from 'self' (no inline script)"]);
  });

  it('fails img-src https:', () => {
    const csp = NGINX_CSP.replace("img-src 'self' data:", "img-src 'self' data: https:");
    assert.deepEqual(failed(csp), ['images only from the frontend (and data:)']);
  });

  it('fails no default-src', () => {
    const csp = NGINX_CSP.replace("default-src 'self'; ", '');
    assert.ok(failed(csp).includes("default-src is 'self'"));
  });
});
