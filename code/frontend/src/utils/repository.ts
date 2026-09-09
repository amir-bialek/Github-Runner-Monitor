export function repositoryShortName(repository: string): string {
  const slash = repository.indexOf('/');
  return slash > -1 && slash < repository.length - 1 ? repository.slice(slash + 1) : repository;
}

export function branchTreeUrl(repositoryUrl: string, branch: string): string {
  const path = branch.split('/').map(encodeURIComponent).join('/');
  return `${repositoryUrl}/tree/${path}`;
}
