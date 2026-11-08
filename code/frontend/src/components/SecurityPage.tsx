import React, { useId } from 'react';
import { Box, Button, Chip, Container, List, ListItem, Paper, Stack, Typography } from '@mui/material';
import { pillSx } from './SessionControl';
import ExternalLink from './ExternalLink';
import { SECURITY_DOC_URL } from '../appConfig';

// A static page: every word below is fixed text, nothing comes from the
// running install. The sentences are exported so the tests can check that
// docs/security-design.md says the same thing.

export const SECURITY_CONTROLS: readonly string[] = [
  'The agent reaches only the Anthropic API.',
  'The agent holds no GitHub, Kubernetes or cloud credential.',
  'Only the key helper container holds the Anthropic key.',
  'The agent can only read, search and edit files in its own work folder.',
  'Only the backend writes to GitHub, and only draft pull requests after it validates the patch.',
  'Every check runs on the backend.',
  'No key or token appears in logs, run records or the browser.',
  'Every debug run and fix pull request is recorded.',
];

export const SECURITY_TERMS: readonly string[] = [
  'Only Anthropic API keys are accepted, and Claude subscription tokens are refused.',
  'Each run is billed to the owner of the key it uses.',
  'Code and job logs go to Anthropic under the commercial terms of the key owner.',
];

export const SECURITY_TERMS_URL = `${SECURITY_DOC_URL}#anthropic-terms`;

export type FlowPart =
  | 'Dashboard'
  | 'Backend'
  | 'Kubernetes API'
  | 'Debug Job pod'
  | 'Anthropic API'
  | 'GitHub API'
  | 'S3';

interface PartBox {
  name: FlowPart;
  description: string;
  containers?: readonly string[];
}

export const FLOW_PARTS: readonly PartBox[] = [
  { name: 'Dashboard', description: 'Your browser. Shows results as plain text.' },
  { name: 'Backend', description: 'Runs every check and is the only writer to GitHub.' },
  { name: 'Kubernetes API', description: 'Runs one Debug Job per debug run.' },
  {
    name: 'Debug Job pod',
    description: 'Isolated by NetworkPolicies. Removed soon after the run ends.',
    containers: ['receiver', 'claude', 'key helper'],
  },
  { name: 'Anthropic API', description: 'The only outside address the Debug Job reaches, through the key helper.' },
  { name: 'GitHub API', description: 'Reached only by the backend.' },
  { name: 'S3', description: 'Holds run records and results.' },
];

interface FlowStep {
  from: FlowPart;
  to: FlowPart;
  text: string;
}

// Story 8.3's steps, as in docs/security-design.md.
export const FLOW_STEPS: readonly FlowStep[] = [
  {
    from: 'Dashboard',
    to: 'Backend',
    text: 'A signed in user presses Debug it. The backend checks the session, the allowed user and access to the repository.',
  },
  {
    from: 'Backend',
    to: 'Kubernetes API',
    text: 'The backend creates the Debug Job, then a Secret for that run only.',
  },
  {
    from: 'Backend',
    to: 'GitHub API',
    text: 'The backend downloads the job log and the code with a read only token narrowed to one repository.',
  },
  {
    from: 'Backend',
    to: 'Debug Job pod',
    text: 'The backend streams the log and the code to the receiver container.',
  },
  {
    from: 'Debug Job pod',
    to: 'Anthropic API',
    text: 'claude calls the key helper, which adds the Anthropic key and forwards the request.',
  },
  {
    from: 'Debug Job pod',
    to: 'Backend',
    text: "The result goes to the backend's results port with the run's result code.",
  },
  {
    from: 'Backend',
    to: 'S3',
    text: 'The backend checks the result and stores it with the run record.',
  },
  {
    from: 'Backend',
    to: 'Dashboard',
    text: 'The dashboard shows the explanation and the patch as plain text.',
  },
  {
    from: 'Backend',
    to: 'GitHub API',
    text: 'On Open a PR, the backend validates the patch again and opens a draft pull request as the Debug it GitHub App.',
  },
];

const visuallyHidden = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const id = useId();
  return (
    <Paper component="section" aria-labelledby={id} variant="outlined" sx={{ p: 2.5 }}>
      <Typography id={id} variant="h6" component="h3" sx={{ fontSize: 16, fontWeight: 600, mb: 1.5 }}>
        {title}
      </Typography>
      {children}
    </Paper>
  );
};

const SentenceList: React.FC<{ label: string; sentences: readonly string[] }> = ({ label, sentences }) => (
  <List aria-label={label} disablePadding sx={{ listStyleType: 'disc', pl: 2.5 }}>
    {sentences.map((sentence) => (
      <ListItem key={sentence} disableGutters sx={{ display: 'list-item', py: 0.25 }}>
        <Typography variant="body2">{sentence}</Typography>
      </ListItem>
    ))}
  </List>
);

const PartChip: React.FC<{ name: FlowPart }> = ({ name }) => (
  <Chip label={name} size="small" variant="outlined" sx={{ fontWeight: 600 }} />
);

interface SecurityPageProps {
  onBack: () => void;
}

const SecurityPage: React.FC<SecurityPageProps> = ({ onBack }) => (
  <Container component="main" maxWidth="md" sx={{ mt: 3, mb: 6 }}>
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
      <Typography variant="h5" component="h2" sx={{ fontWeight: 700 }}>
        Debug it security
      </Typography>
      <Button variant="outlined" color="inherit" size="small" onClick={onBack} sx={[pillSx, { ml: 'auto' }]}>
        Back to dashboard
      </Button>
    </Box>
    <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
      How Debug it keeps code, keys and GitHub safe while Claude looks at a failed job. The full details are in the{' '}
      <ExternalLink href={SECURITY_DOC_URL} label="Security design document">
        security design document
      </ExternalLink>
      .
    </Typography>

    <Stack spacing={3}>
      <Section title="How a debug run flows">
        <List
          aria-label="Parts"
          disablePadding
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mb: 2.5 }}
        >
          {FLOW_PARTS.map((part) => (
            <ListItem
              key={part.name}
              disablePadding
              sx={{ width: 'auto', flex: '1 1 180px', display: 'block' }}
            >
              <Paper
                variant="outlined"
                sx={{ p: 1.5, height: '100%', bgcolor: 'background.default' }}
              >
                <Typography variant="subtitle2" component="p" sx={{ fontWeight: 700 }}>
                  {part.name}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {part.description}
                </Typography>
                {part.containers && (
                  <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, mt: 1 }}>
                    {part.containers.map((container) => (
                      <Chip key={container} label={container} size="small" />
                    ))}
                  </Box>
                )}
              </Paper>
            </ListItem>
          ))}
        </List>

        <Box
          component="ol"
          aria-label="Steps"
          sx={{ m: 0, pl: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}
        >
          {FLOW_STEPS.map((step, index) => (
            <Box component="li" key={index}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <PartChip name={step.from} />
                <Box component="span" aria-hidden="true" sx={{ color: 'text.secondary', fontWeight: 700 }}>
                  →
                </Box>
                <Box component="span" sx={visuallyHidden}>
                  to
                </Box>
                <PartChip name={step.to} />
              </Box>
              <Typography variant="body2">{step.text}</Typography>
            </Box>
          ))}
        </Box>
      </Section>

      <Section title="Main controls">
        <SentenceList label="Main controls" sentences={SECURITY_CONTROLS} />
      </Section>

      <Section title="Anthropic terms">
        <SentenceList label="Anthropic terms" sentences={SECURITY_TERMS} />
        <Typography variant="body2" sx={{ mt: 1.5 }}>
          <ExternalLink href={SECURITY_TERMS_URL} label="Anthropic terms in the security design document">
            Read the Anthropic terms section
          </ExternalLink>
        </Typography>
      </Section>

      <Typography variant="body2">
        <ExternalLink href={SECURITY_DOC_URL} label="Full security design document">
          Read the full security design document
        </ExternalLink>
      </Typography>
    </Stack>
  </Container>
);

export default SecurityPage;
