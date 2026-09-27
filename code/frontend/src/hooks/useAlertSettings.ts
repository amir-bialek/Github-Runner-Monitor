import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchAlertSettings,
  resetAlertSettings,
  sendTestAlert,
  updateAlertSettings,
} from '../services/api';
import type { AlertSettingsResponse } from '../types/api';

const KEY = ['alert-settings'];

export const useAlertSettings = (enabled: boolean) => {
  return useQuery({
    queryKey: KEY,
    queryFn: fetchAlertSettings,
    enabled,
    refetchInterval: false,
  });
};

export const useAlertSettingsMutations = () => {
  const queryClient = useQueryClient();
  const onSaved = (data: AlertSettingsResponse) => {
    queryClient.setQueryData(KEY, data);
    void queryClient.invalidateQueries({ queryKey: ['alerts'] });
  };

  const save = useMutation({ mutationFn: updateAlertSettings, onSuccess: onSaved });
  const reset = useMutation({ mutationFn: resetAlertSettings, onSuccess: onSaved });
  const test = useMutation({
    mutationFn: sendTestAlert,
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });

  return { save, reset, test };
};
