// The frontend's nginx config keeps a strict Content-Security-Policy (story 3.12):
// result text from a debug run is rendered as plain text, and the policy is the
// second line of defence. nginx drops server level add_header lines in any
// location that has its own, so every such location must repeat the header.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const config = readFileSync(resolve(__dirname, '../../../docker/nginx.conf'), 'utf8');

function policy(): string {
  const match = /set \$csp "([^"]*)";/.exec(config);
  if (!match?.[1]) throw new Error('nginx.conf sets no $csp');
  return match[1];
}

function directives(): Map<string, string> {
  return new Map(
    policy()
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name, values.join(' ')] as [string, string];
      }),
  );
}

// The body of each location block (no nested blocks in this config).
function locations(): Array<{ head: string; body: string }> {
  const found: Array<{ head: string; body: string }> = [];
  const pattern = /location\s+([^{]*)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(config)) !== null) found.push({ head: (match[1] ?? '').trim(), body: match[2] ?? '' });
  return found;
}

describe('nginx Content-Security-Policy', () => {
  test("default-src and script-src are 'self' only", () => {
    expect(directives().get('default-src')).toBe("'self'");
    expect(directives().get('script-src')).toBe("'self'");
  });

  test('no outside host anywhere in the policy', () => {
    expect(policy()).not.toMatch(/https?:/i);
    expect(policy()).not.toMatch(/\*/);
    for (const name of ['img-src', 'connect-src']) {
      const value = directives().get(name);
      if (value === undefined) continue;
      for (const source of value.split(/\s+/)) expect(["'self'", 'data:']).toContain(source);
    }
  });

  test('the server and every location with add_header send the policy', () => {
    const blocks = locations();
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      if (!block.body.includes('add_header')) continue;
      expect({ location: block.head, csp: /add_header Content-Security-Policy \$csp always;/.test(block.body) }).toEqual({
        location: block.head,
        csp: true,
      });
    }
    const serverLevel = config.replace(/location\s+[^{]*\{[^}]*\}/g, '');
    expect(serverLevel).toMatch(/add_header Content-Security-Policy \$csp always;/);
  });
});
