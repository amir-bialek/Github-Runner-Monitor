import React from 'react';
import ExternalLink from './ExternalLink';
import { orUnknown } from '../utils/labels';
import { branchTreeUrl } from '../utils/repository';

interface BranchLinkProps {
  repository: string;
  repositoryUrl: string;
  branch: string | null;
}

const BranchLink: React.FC<BranchLinkProps> = ({ repository, repositoryUrl, branch }) =>
  branch ? (
    <ExternalLink
      href={branchTreeUrl(repositoryUrl, branch)}
      label={`Branch ${branch} in ${repository}`}
    >
      {branch}
    </ExternalLink>
  ) : (
    <>{orUnknown(branch)}</>
  );

export default BranchLink;
