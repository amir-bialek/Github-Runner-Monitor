import React from 'react';
import { orUnknown } from '../utils/labels';

interface RepositoryPathProps {
  repository: string;
  branch: string | null;
}

const RepositoryPath: React.FC<RepositoryPathProps> = ({ repository, branch }) => (
  <>{repositoryPathText(repository, branch)}</>
);

export function repositoryShortName(repository: string): string {
  const slash = repository.indexOf('/');
  return slash > -1 && slash < repository.length - 1 ? repository.slice(slash + 1) : repository;
}

export function repositoryPathText(repository: string, branch: string | null): string {
  return `${repositoryShortName(repository)}/${orUnknown(branch)}`;
}

export default RepositoryPath;
