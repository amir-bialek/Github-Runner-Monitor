import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addAllowedRepository,
  addAllowedUser,
  fetchDebugItSettings,
  fetchDebugItUsage,
  removeAllowedRepository,
  removeAllowedUser,
} from '../services/api';
import type { DebugItSettingsView } from '../types/api';

export const DEBUG_IT_SETTINGS_KEY = ['debug-it-settings'];

/** How often the settings are fetched again while the startup isolation check runs. */
export const ISOLATION_CHECKING_REFETCH_MS = 5000;

export const useDebugItSettings = () => {
  return useQuery({
    queryKey: DEBUG_IT_SETTINGS_KEY,
    queryFn: fetchDebugItSettings,
    // A failing refetch stops the polling; the page offers Try again / Reload.
    refetchInterval: (query) =>
      query.state.status !== 'error' && query.state.data?.isolation?.state === 'checking'
        ? ISOLATION_CHECKING_REFETCH_MS
        : false,
  });
};

export const DEBUG_IT_USAGE_KEY = ['debug-it-usage'];

/** The usage of the current UTC month (story 3.13). */
export const useDebugItUsage = () => {
  return useQuery({ queryKey: DEBUG_IT_USAGE_KEY, queryFn: fetchDebugItUsage });
};

export const useDebugItSettingsMutations = () => {
  const queryClient = useQueryClient();
  // Every change answers the lists as now stored.
  const onSaved = (data: DebugItSettingsView) => {
    queryClient.setQueryData(DEBUG_IT_SETTINGS_KEY, data);
  };

  const addRepository = useMutation({ mutationFn: addAllowedRepository, onSuccess: onSaved });
  const removeRepository = useMutation({ mutationFn: removeAllowedRepository, onSuccess: onSaved });
  const addUser = useMutation({ mutationFn: addAllowedUser, onSuccess: onSaved });
  const removeUser = useMutation({ mutationFn: removeAllowedUser, onSuccess: onSaved });

  return { addRepository, removeRepository, addUser, removeUser };
};
