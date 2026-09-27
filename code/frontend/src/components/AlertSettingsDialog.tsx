import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  InputAdornment,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import { useAlertSettings, useAlertSettingsMutations } from '../hooks/useAlertSettings';
import type { AlertSettingsResponse, AlertSettingsUpdate } from '../types/api';
import { formatShortDateTime, parseTimestamp } from '../utils/format';

interface AlertSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const MAX_MINUTES = 7 * 24 * 60;

interface Draft {
  queueEnabled: boolean;
  queueMinutes: string;
  offlineEnabled: boolean;
  offlineMinutes: string;
  webhookUrl: string;
  removeWebhook: boolean;
}

function draftFrom(data: AlertSettingsResponse): Draft {
  return {
    queueEnabled: data.settings.queueWait.enabled,
    queueMinutes: String(data.settings.queueWait.thresholdMinutes),
    offlineEnabled: data.settings.runnerGroupOffline.enabled,
    offlineMinutes: String(data.settings.runnerGroupOffline.thresholdMinutes),
    webhookUrl: '',
    removeWebhook: false,
  };
}

function minutesError(value: string): string | null {
  if (!/^\d+$/.test(value.trim())) return 'Whole minutes only';
  const minutes = Number(value);
  if (minutes < 1 || minutes > MAX_MINUTES) return `Between 1 and ${MAX_MINUTES}`;
  return null;
}

function urlError(value: string): string | null {
  if (!value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? null : 'Must start with https:// or http://';
  } catch {
    return 'Not a valid URL';
  }
}

function buildUpdate(draft: Draft): AlertSettingsUpdate {
  const update: AlertSettingsUpdate = {
    queueWait: { enabled: draft.queueEnabled, thresholdMinutes: Number(draft.queueMinutes) },
    runnerGroupOffline: { enabled: draft.offlineEnabled, thresholdMinutes: Number(draft.offlineMinutes) },
  };
  if (draft.removeWebhook) update.webhookUrl = null;
  else if (draft.webhookUrl.trim()) update.webhookUrl = draft.webhookUrl.trim();
  return update;
}

function errorText(error: unknown): string {
  return (error as Error | null)?.message ?? 'Something went wrong';
}

const RuleFields: React.FC<{
  label: string;
  description: string;
  enabled: boolean;
  minutes: string;
  deploymentMinutes: number;
  disabled: boolean;
  onEnabled: (value: boolean) => void;
  onMinutes: (value: string) => void;
}> = ({ label, description, enabled, minutes, deploymentMinutes, disabled, onEnabled, onMinutes }) => {
  const error = enabled ? minutesError(minutes) : null;
  return (
    <Box>
      <FormControlLabel
        control={<Switch checked={enabled} onChange={(event) => onEnabled(event.target.checked)} disabled={disabled} />}
        label={<Typography sx={{ fontWeight: 700 }}>{label}</Typography>}
      />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {description}
      </Typography>
      <TextField
        label="Threshold"
        size="small"
        value={minutes}
        onChange={(event) => onMinutes(event.target.value)}
        disabled={disabled || !enabled}
        error={Boolean(error)}
        helperText={error ?? `Deployment value: ${deploymentMinutes} min`}
        slotProps={{
          input: { endAdornment: <InputAdornment position="end">minutes</InputAdornment> },
          htmlInput: { inputMode: 'numeric', 'aria-label': `${label} threshold in minutes` },
        }}
        sx={{ width: 220 }}
      />
    </Box>
  );
};

const AlertSettingsDialog: React.FC<AlertSettingsDialogProps> = ({ open, onClose }) => {
  const query = useAlertSettings(open);
  const { save, reset, test } = useAlertSettingsMutations();
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    if (open && query.data && !draft) setDraft(draftFrom(query.data));
  }, [open, query.data, draft]);

  useEffect(() => {
    if (!open) {
      setDraft(null);
      save.reset();
      reset.reset();
      test.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const data = query.data;
  const locked = data ? !data.editable : true;
  const busy = save.isPending || reset.isPending;

  const invalid = useMemo(() => {
    if (!draft) return true;
    return Boolean(
      (draft.queueEnabled && minutesError(draft.queueMinutes)) ||
        (draft.offlineEnabled && minutesError(draft.offlineMinutes)) ||
        (!draft.removeWebhook && urlError(draft.webhookUrl)),
    );
  }, [draft]);

  const handleSave = () => {
    if (!draft || invalid) return;
    save.mutate(buildUpdate(draft), { onSuccess: onClose });
  };

  const lastSuccess = parseTimestamp(data?.webhookStatus.lastSuccessAt);
  const webhookError = data?.webhookStatus.lastError;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="alert-settings-title">
      <DialogTitle id="alert-settings-title" sx={{ fontWeight: 700 }}>
        Alert settings
      </DialogTitle>
      <DialogContent dividers>
        {query.isLoading || !draft || !data ? (
          query.error ? (
            <Alert severity="error">{errorText(query.error)}</Alert>
          ) : (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress aria-label="Loading alert settings" />
            </Box>
          )
        ) : (
          <Stack spacing={3}>
            {locked && (
              <Alert severity="info">
                These settings are fixed by the deployment (ALERT_SETTINGS_EDITABLE=false) and cannot be changed here.
              </Alert>
            )}

            <RuleFields
              label="Queue wait"
              description="Alert when a job has been waiting for a runner longer than this."
              enabled={draft.queueEnabled}
              minutes={draft.queueMinutes}
              deploymentMinutes={data.deploymentDefaults.queueWait.thresholdMinutes}
              disabled={locked}
              onEnabled={(queueEnabled) => setDraft({ ...draft, queueEnabled })}
              onMinutes={(queueMinutes) => setDraft({ ...draft, queueMinutes })}
            />

            <RuleFields
              label="Runner group offline"
              description="Alert when a runner group has had no online runners for longer than this."
              enabled={draft.offlineEnabled}
              minutes={draft.offlineMinutes}
              deploymentMinutes={data.deploymentDefaults.runnerGroupOffline.thresholdMinutes}
              disabled={locked}
              onEnabled={(offlineEnabled) => setDraft({ ...draft, offlineEnabled })}
              onMinutes={(offlineMinutes) => setDraft({ ...draft, offlineMinutes })}
            />

            <Divider />

            <Box>
              <Typography sx={{ fontWeight: 700, mb: 0.5 }}>Delivery</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
                Alerts always show at the top of this page. Add a webhook to also receive a JSON POST when an alert
                fires or clears. The body has a <code>text</code> field, so a Slack or Teams incoming webhook works as is.
              </Typography>

              {data.settings.webhookConfigured && !draft.removeWebhook && (
                <Typography variant="body2" sx={{ mb: 1 }}>
                  {`Current webhook: ${data.settings.webhookUrlMasked}`}
                </Typography>
              )}

              <TextField
                label={data.settings.webhookConfigured ? 'Replace webhook URL' : 'Webhook URL'}
                placeholder="https://hooks.example.com/…"
                size="small"
                fullWidth
                value={draft.webhookUrl}
                onChange={(event) => setDraft({ ...draft, webhookUrl: event.target.value, removeWebhook: false })}
                disabled={locked}
                error={Boolean(urlError(draft.webhookUrl))}
                helperText={urlError(draft.webhookUrl) ?? 'Leave empty to keep the current setting.'}
              />

              <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
                {data.settings.webhookConfigured && (
                  <Button
                    size="small"
                    color="inherit"
                    disabled={locked}
                    onClick={() => setDraft({ ...draft, removeWebhook: !draft.removeWebhook, webhookUrl: '' })}
                  >
                    {draft.removeWebhook ? 'Keep webhook' : 'Remove webhook'}
                  </Button>
                )}
                {data.settings.webhookConfigured && (
                  <Button size="small" disabled={locked || test.isPending} onClick={() => test.mutate()}>
                    Send test
                  </Button>
                )}
                {draft.removeWebhook && (
                  <Typography variant="body2" color="warning.main">
                    The webhook will be removed when you save — on-screen only.
                  </Typography>
                )}
              </Stack>

              {test.isSuccess && !test.data.lastError && (
                <Alert severity="success" sx={{ mt: 1.5 }}>
                  Test sent.
                </Alert>
              )}
              {(test.isError || (test.isSuccess && test.data.lastError)) && (
                <Alert severity="error" sx={{ mt: 1.5 }}>
                  {test.isError ? errorText(test.error) : `Test failed: ${test.data?.lastError}`}
                </Alert>
              )}
              {!test.isSuccess && !test.isError && data.settings.webhookConfigured && (webhookError || lastSuccess) && (
                <Typography variant="caption" color={webhookError ? 'error' : 'text.secondary'} sx={{ display: 'block', mt: 1 }}>
                  {webhookError
                    ? `Last delivery failed: ${webhookError}`
                    : `Last delivered ${formatShortDateTime(lastSuccess!)}`}
                </Typography>
              )}
            </Box>

            <Divider />

            <Box>
              <Typography variant="body2" color="text.secondary">
                {data.source === 'ui'
                  ? 'Changed here, so these values override the deployment values.'
                  : 'Using the values set at deploy time (Helm values or environment).'}{' '}
                {data.persisted
                  ? 'Saved to S3 alongside the job list, so they survive a restart.'
                  : 'No S3 bucket is configured, so changes here last until the backend restarts.'}
              </Typography>
            </Box>

            {(save.isError || reset.isError) && (
              <Alert severity="error">{errorText(save.error ?? reset.error)}</Alert>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        {data?.source === 'ui' && !locked && (
          <Button color="inherit" disabled={busy} onClick={() => reset.mutate(undefined, { onSuccess: (fresh) => setDraft(draftFrom(fresh)) })} sx={{ mr: 'auto' }}>
            Reset to deployment values
          </Button>
        )}
        <Button color="inherit" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={locked || invalid || busy}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default AlertSettingsDialog;
