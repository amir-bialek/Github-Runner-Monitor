import React from 'react';
import ExternalLink from './ExternalLink';
import { repositoryShortName } from '../utils/repository';

interface RepositoryLinkProps {
  repository: string;
  repositoryUrl: string;
}

const RepositoryLink: React.FC<RepositoryLinkProps> = ({ repository, repositoryUrl }) => (
  <ExternalLink href={repositoryUrl} label={`Repository ${repository}`}>
    {repositoryShortName(repository)}
  </ExternalLink>
);

export default RepositoryLink;
