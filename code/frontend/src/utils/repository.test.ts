import { branchTreeUrl, repositoryShortName } from './repository';

describe('repositoryShortName', () => {
  test('drops the owner, which is the same on every row', () => {
    expect(repositoryShortName('acme/web-app')).toBe('web-app');
  });

  test('keeps a name that has no owner in front of it', () => {
    expect(repositoryShortName('web-app')).toBe('web-app');
    expect(repositoryShortName('acme/')).toBe('acme/');
  });
});

describe('branchTreeUrl', () => {
  test('points at the branch on github.com', () => {
    expect(branchTreeUrl('https://github.com/acme/web-app', 'main')).toBe(
      'https://github.com/acme/web-app/tree/main',
    );
  });

  test('keeps the slashes in a branch path, which github expects', () => {
    expect(branchTreeUrl('https://github.com/acme/web-app', 'feature/telemetry-export')).toBe(
      'https://github.com/acme/web-app/tree/feature/telemetry-export',
    );
  });

  test('encodes what would otherwise break the url, segment by segment', () => {
    expect(branchTreeUrl('https://github.com/acme/web-app', 'feature/foo bar')).toBe(
      'https://github.com/acme/web-app/tree/feature/foo%20bar',
    );
    expect(branchTreeUrl('https://github.com/acme/web-app', 'fix/#42?x=1')).toBe(
      'https://github.com/acme/web-app/tree/fix/%2342%3Fx%3D1',
    );
    expect(branchTreeUrl('https://github.com/acme/web-app', '100%pure')).toBe(
      'https://github.com/acme/web-app/tree/100%25pure',
    );
  });
});
