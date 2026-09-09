import React from 'react';
import Link, { LinkProps } from '@mui/material/Link';

interface ExternalLinkProps extends LinkProps {
  label?: string;
}

const ExternalLink: React.FC<ExternalLinkProps> = ({ children, label, ...props }) => (
  <Link
    target="_blank"
    rel="noopener noreferrer"
    underline="hover"
    aria-label={label ? `${label} — opens on github.com` : undefined}
    {...props}
  >
    {children}
  </Link>
);

export default ExternalLink;
