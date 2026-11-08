import React, { useEffect, useId, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { useDeletePersonalKey, usePersonalKey, useSavePersonalKey } from '../hooks/usePersonalKey';

export const KEY_WORKS_NOTICE = 'Your personal key works.';

interface PersonalKeyDialogProps {
  open: boolean;
  onClose: () => void;
  /** Why the key is asked for now (a Debug it click with no saved key); the form shows at once. */
  startReason?: string;
  /** Called after a successful save; without it the dialog stays open on the saved view. */
  onSaved?: () => void;
}

const cancelledSentence = (count: number) =>
  count === 1 ? '1 waiting debug run was cancelled.' : `${count} waiting debug runs were cancelled.`;

interface DeletedNote {
  cancelledRuns: number;
}

/**
 * The body lives only while the dialog is open, so the typed key (held in
 * this component's state only) is gone once it closes.
 */
const PersonalKeyBody: React.FC<
  Omit<PersonalKeyDialogProps, 'open'> & { titleId: string; onSavingChange: (saving: boolean) => void }
> = ({ onClose, startReason, onSaved, titleId, onSavingChange }) => {
  const statusQuery = usePersonalKey(true);
  const saveMutation = useSavePersonalKey();
  const deleteMutation = useDeletePersonalKey();
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [deleted, setDeleted] = useState<DeletedNote | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const status = statusQuery.data;
  const statusError = statusQuery.error as Error | null;
  const saveError = saveMutation.error as Error | null;
  const deleteError = deleteMutation.error as Error | null;
  const busy = saveMutation.isPending || deleteMutation.isPending;

  // The form shows when no key is saved, while replacing, or when a Debug it click asks for the key.
  const showForm = Boolean(startReason) || replacing || (status !== undefined && !status.saved) || (!status && !!statusError);

  // While a save is in flight the dialog cannot close: closing would drop the
  // save's answer, so a Debug it click would never start its run.
  const saving = saveMutation.isPending;
  useEffect(() => {
    onSavingChange(saving);
  }, [saving, onSavingChange]);
  useEffect(() => () => onSavingChange(false), [onSavingChange]);

  // A refused key keeps the input focused, so the user can paste another.
  useEffect(() => {
    if (saveError) inputRef.current?.focus();
  }, [saveError]);

  const close = () => {
    if (saving) return;
    setKey('');
    onClose();
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const typed = key.trim();
    if (!typed || busy) return;
    setDeleted(null);
    setSavedNotice(false);
    deleteMutation.reset();
    saveMutation.mutate(
      { key: typed },
      {
        onSuccess: () => {
          setKey('');
          setReplacing(false);
          if (onSaved) onSaved();
          else setSavedNotice(true);
        },
      },
    );
  };

  const cancel = () => {
    setKey('');
    saveMutation.reset();
    if (replacing && !startReason) setReplacing(false);
    else close();
  };

  const startReplace = () => {
    setKey('');
    setSavedNotice(false);
    setDeleted(null);
    saveMutation.reset();
    deleteMutation.reset();
    setReplacing(true);
  };

  const remove = () => {
    if (busy) return;
    setSavedNotice(false);
    setDeleted(null);
    saveMutation.reset();
    deleteMutation.mutate(undefined, {
      onSuccess: (answer) => setDeleted({ cancelledRuns: answer.cancelledRuns }),
    });
  };

  let body: React.ReactNode;
  if (!status && statusQuery.isPending && !showForm) {
    body = (
      <Box aria-live="polite" role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
        <CircularProgress size={20} aria-hidden />
        <Typography>Loading your personal key…</Typography>
      </Box>
    );
  } else if (showForm) {
    const inputId = `${titleId}-key`;
    body = (
      <Box component="form" onSubmit={submit} noValidate sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {startReason && <Typography id={`${titleId}-reason`}>{startReason}</Typography>}
        {!startReason && !replacing && !status?.saved && <Typography>No personal key saved.</Typography>}
        {status?.saved && status.last4 && (
          <Typography color="text.secondary">
            {'Replacing the key ending in '}
            {status.last4}
          </Typography>
        )}
        {deleted && deleted.cancelledRuns > 0 && (
          <Alert severity="info">{cancelledSentence(deleted.cancelledRuns)}</Alert>
        )}
        {statusError && !status && <Alert severity="warning">{statusError.message}</Alert>}
        <Typography variant="body2" color="text.secondary">
          Debug runs you start use this Anthropic API key and are billed to it. It is checked with Anthropic before it
          is saved, stored encrypted, and only its last 4 characters are ever shown.
        </Typography>
        <TextField
          id={inputId}
          label="Anthropic API key"
          type="password"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            if (saveMutation.isError) saveMutation.reset();
          }}
          autoComplete="off"
          inputRef={inputRef}
          autoFocus
          fullWidth
          disabled={saveMutation.isPending}
          slotProps={{ htmlInput: { spellCheck: false, autoCapitalize: 'off', autoCorrect: 'off' } }}
        />
        {saveError && <Alert severity="error">{saveError.message}</Alert>}
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'flex-end' }}>
          <Button type="button" onClick={cancel} disabled={saveMutation.isPending}>
            Cancel
          </Button>
          <Button type="submit" variant="contained" disabled={!key.trim() || busy}>
            {saveMutation.isPending ? 'Checking and saving…' : 'Save key'}
          </Button>
        </Stack>
      </Box>
    );
  } else if (status?.saved) {
    body = (
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {savedNotice && <Alert severity="success">{KEY_WORKS_NOTICE}</Alert>}
        <Typography sx={{ fontWeight: 600 }}>
          {status.last4 ? (
            <>
              {'Key ending in '}
              {status.last4}
            </>
          ) : (
            'A personal key is saved.'
          )}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Debug runs you start use this key and are billed to it.
        </Typography>
        {deleteError && <Alert severity="error">{deleteError.message}</Alert>}
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" onClick={startReplace} disabled={busy}>
            Replace
          </Button>
          <Button variant="outlined" color="error" onClick={remove} disabled={busy}>
            {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
          </Button>
        </Stack>
      </Box>
    );
  }

  return (
    <>
      <DialogContent dividers>{body}</DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={close} disabled={saving}>
          Close
        </Button>
      </DialogActions>
    </>
  );
};

/**
 * The signed in user's personal Anthropic API key (story 5.2): save, replace
 * and delete. Only the key's last 4 characters are ever shown. The typed key
 * lives only in this dialog's component state.
 */
const PersonalKeyDialog: React.FC<PersonalKeyDialogProps> = ({ open, onClose, startReason, onSaved }) => {
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  // Escape and the backdrop are ignored while a save is in flight.
  const requestClose = () => {
    if (!saving) onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={requestClose}
      maxWidth="sm"
      fullWidth
      aria-labelledby={titleId}
      aria-describedby={startReason ? `${titleId}-reason` : undefined}
    >
      <DialogTitle id={titleId} sx={{ fontWeight: 700 }}>
        Personal Anthropic API key
      </DialogTitle>
      {open && (
        <PersonalKeyBody
          onClose={onClose}
          startReason={startReason}
          onSaved={onSaved}
          titleId={titleId}
          onSavingChange={setSaving}
        />
      )}
    </Dialog>
  );
};

export default PersonalKeyDialog;
