import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deletePersonalKey, fetchPersonalKey, savePersonalKey } from '../services/api';
import { shouldRetry } from '../queryClient';
import type { PersonalKeyStatus } from '../types/api';
import { DEBUG_IT_RUNS_KEY } from './useDebugRuns';

/**
 * The signed in user's personal key status (story 5.2), shared by the header
 * dialog and the Debug it column. Only the answered status is cached, never
 * the key itself.
 */
export const PERSONAL_KEY_KEY = ['debug-it-personal-key'];

/** Read only for allowed users in personal key mode. */
export const usePersonalKey = (enabled: boolean) => {
  return useQuery({
    queryKey: PERSONAL_KEY_KEY,
    queryFn: () => fetchPersonalKey(),
    enabled,
    retry: shouldRetry,
  });
};

/** What a save is called with. The key is wiped from it once the save settles. */
export interface PersonalKeyInput {
  key: string;
}

/**
 * Saves (or replaces) the key; the answered status replaces the cached one.
 * TanStack Query keeps a mutation's variables in its mutation cache, so the
 * key is cleared from them as soon as the request settles, and the mutation
 * is dropped from that cache as soon as nothing observes it.
 */
export const useSavePersonalKey = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: PersonalKeyInput) => savePersonalKey(input.key),
    gcTime: 0,
    onSuccess: (status) => {
      queryClient.setQueryData<PersonalKeyStatus>(PERSONAL_KEY_KEY, status);
    },
    onSettled: (_data, _error, input) => {
      input.key = '';
    },
  });
};

/** Deletes the key; the runs overview is read again, since waiting runs may have been cancelled. */
export const useDeletePersonalKey = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deletePersonalKey(),
    onSuccess: ({ cancelledRuns: _cancelledRuns, ...status }) => {
      queryClient.setQueryData<PersonalKeyStatus>(PERSONAL_KEY_KEY, status);
      void queryClient.invalidateQueries({ queryKey: DEBUG_IT_RUNS_KEY });
    },
  });
};
