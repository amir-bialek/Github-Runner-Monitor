import { Request, Response, NextFunction } from 'express';

export function authenticateGitHub(req: Request, res: Response, next: NextFunction) {
  if (process.env.USE_MOCK_DATA === 'true') {
    (req as any).githubToken = 'mock-token';
    return next();
  }

  const token = process.env.GITHUB_TOKEN;

  if (!token) {
    console.error('GitHub token not configured');
    return res.status(500).json({ error: 'GitHub token not configured' });
  }

  if (!isValidToken(token)) {
    console.error('Invalid GitHub token format');
    return res.status(400).json({ error: 'Invalid GitHub token format' });
  }

  (req as any).githubToken = token;

  console.log(`[AUDIT] Authentication successful for request to ${req.path}`);

  next();
};

function isValidToken(token: string): boolean {
  const prefixes = ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'];
  return token.length === 40 || prefixes.some(prefix => token.startsWith(prefix));
}
