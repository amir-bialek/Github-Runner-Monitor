import React, { FormEvent, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Container,
  List,
  ListItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useDebugItSettings, useDebugItSettingsMutations } from '../hooks/useDebugItSettings';
import { pillSx } from './SessionControl';
import DebugItUsageSection from './DebugItUsageSection';
import type { DebugItIsolationStatus } from '../types/api';
import { formatDateThenTime } from '../utils/format';

export const ISOLATION_RETRY = 'Restart the backend to run the check again.';

interface DebugItSettingsPageProps {
  onBack: () => void;
}

interface Entry {
  key: string;
  label: string;
  removeLabel: string;
  onRemove: () => void;
}

interface ListSectionProps {
  title: string;
  description: string;
  emptyText: string;
  entries: Entry[];
  fieldLabel: string;
  placeholder: string;
  addLabel: string;
  busy: boolean;
  onAdd: (value: string, done: () => void) => void;
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : undefined;
}

function messageOf(error: unknown): string {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() ? message : 'Something went wrong talking to the monitor.';
}

const ListSection: React.FC<ListSectionProps> = ({
  title,
  description,
  emptyText,
  entries,
  fieldLabel,
  placeholder,
  addLabel,
  busy,
  onAdd,
}) => {
  const [value, setValue] = useState('');
  const headingId = `${title.toLowerCase().replace(/\s+/g, '-')}-heading`;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    onAdd(trimmed, () => setValue(''));
  };

  return (
    <Paper component="section" aria-labelledby={headingId} variant="outlined" sx={{ p: 2.5 }}>
      <Typography id={headingId} variant="h6" component="h3" sx={{ fontSize: 16, fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 1.5 }}>
        {description}
      </Typography>

      {entries.length === 0 ? (
        <Typography variant="body2" sx={{ py: 1 }}>
          {emptyText}
        </Typography>
      ) : (
        <List dense disablePadding aria-label={title}>
          {entries.map((entry) => (
            <ListItem
              key={entry.key}
              divider
              disableGutters
              secondaryAction={
                <Button
                  size="small"
                  color="error"
                  onClick={entry.onRemove}
                  disabled={busy}
                  aria-label={entry.removeLabel}
                >
                  Remove
                </Button>
              }
            >
              <Typography variant="body2" sx={{ fontFamily: 'monospace', pr: 10, overflowWrap: 'anywhere' }}>
                {entry.label}
              </Typography>
            </ListItem>
          ))}
        </List>
      )}

      <Box component="form" onSubmit={submit} sx={{ display: 'flex', gap: 1, mt: 2, alignItems: 'flex-start' }}>
        <TextField
          size="small"
          label={fieldLabel}
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoComplete="off"
          sx={{ flex: 1, maxWidth: 360 }}
        />
        <Button
          type="submit"
          variant="contained"
          disabled={busy || value.trim() === ''}
          aria-label={addLabel}
          sx={{ textTransform: 'none' }}
        >
          Add
        </Button>
      </Box>
    </Paper>
  );
};

const IsolationAlert: React.FC<{ isolation: DebugItIsolationStatus }> = ({ isolation }) => {
  if (isolation.state === 'on') {
    return (
      <Alert severity="success" sx={{ mb: 2 }}>
        {`Debug it is on. The isolation check passed at ${
          isolation.checkedAt ? formatDateThenTime(new Date(isolation.checkedAt)) : 'an unknown time'
        }.`}
      </Alert>
    );
  }
  if (isolation.state === 'checking') {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        {isolation.reason ?? 'Debug it is off until the startup isolation check finishes.'}
      </Alert>
    );
  }
  return (
    <Alert severity="error" sx={{ mb: 2 }}>
      {`${isolation.reason ?? 'Debug it is off.'} ${ISOLATION_RETRY}`}
    </Alert>
  );
};

const DebugItSettingsPage: React.FC<DebugItSettingsPageProps> = ({ onBack }) => {
  const query = useDebugItSettings();
  const { addRepository, removeRepository, addUser, removeUser } = useDebugItSettingsMutations();
  const [error, setError] = useState<unknown>(null);

  const busy = addRepository.isPending || removeRepository.isPending || addUser.isPending || removeUser.isPending;
  const shownError = error ?? (query.data ? null : query.error);
  const conflict = statusOf(shownError) === 409;

  const handlers = (done?: () => void) => ({
    onSuccess: () => {
      setError(null);
      done?.();
    },
    onError: (e: unknown) => setError(e),
  });

  const reload = () => {
    setError(null);
    void query.refetch();
  };

  const data = query.data;

  return (
    <Container component="main" maxWidth="md" sx={{ mt: 3, mb: 6 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
        <Typography variant="h5" component="h2" sx={{ fontWeight: 700 }}>
          Debug it settings
        </Typography>
        <Button variant="outlined" color="inherit" size="small" onClick={onBack} sx={[pillSx, { ml: 'auto' }]}>
          Back to dashboard
        </Button>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Changes apply on the next Debug it click. Administrators are set in the Helm values.
      </Typography>

      {data?.isolation ? <IsolationAlert isolation={data.isolation} /> : null}

      {shownError ? (
        <Alert
          severity="error"
          sx={{ mb: 2 }}
          action={
            conflict ? (
              <Button color="inherit" size="small" onClick={reload}>
                Reload
              </Button>
            ) : undefined
          }
        >
          {messageOf(shownError)}
        </Alert>
      ) : null}

      {query.isLoading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress aria-label="Loading Debug it settings" />
        </Box>
      ) : data ? (
        <Stack spacing={3}>
          <ListSection
            title="Allowed repositories"
            description="Debug it works only on these repositories."
            emptyText="No repository is allowed, so Debug it cannot be used on any repository."
            entries={data.allowedRepositories.map((repository) => ({
              key: repository,
              label: repository,
              removeLabel: `Remove ${repository}`,
              onRemove: () => removeRepository.mutate(repository, handlers()),
            }))}
            fieldLabel="Repository"
            placeholder="owner/name"
            addLabel="Add repository"
            busy={busy}
            onAdd={(value, done) => addRepository.mutate(value, handlers(done))}
          />
          <ListSection
            title="Allowed users"
            description="Only these GitHub users can use Debug it."
            emptyText="Nobody is allowed to use Debug it."
            entries={data.allowedUsers.map((user) => {
              const label = user.login ?? `user ID ${user.githubUserId}`;
              return {
                key: String(user.githubUserId),
                label,
                removeLabel: `Remove ${label}`,
                onRemove: () => removeUser.mutate(user.githubUserId, handlers()),
              };
            })}
            fieldLabel="GitHub login"
            placeholder="login"
            addLabel="Add user"
            busy={busy}
            onAdd={(value, done) => addUser.mutate(value, handlers(done))}
          />
          <DebugItUsageSection />
        </Stack>
      ) : !shownError ? null : (
        <Button variant="outlined" size="small" onClick={reload} sx={{ textTransform: 'none' }}>
          Try again
        </Button>
      )}
    </Container>
  );
};

export default DebugItSettingsPage;
