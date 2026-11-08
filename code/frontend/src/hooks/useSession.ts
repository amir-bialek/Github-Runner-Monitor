import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchSession, signOut } from '../services/api';
import { shouldRetry } from '../queryClient';
import type { DebugItSession, LoginScope } from '../types/api';

export const SESSION_KEY = ['debug-it-session'];
export const SESSION_REFRESH_MS = 60000;

type SessionQueryState = { state: { data?: DebugItSession } };

const isDisabled = (query: SessionQueryState) => query.state.data?.state === 'disabled';

// Debug it off (404) is final for the page's life: no interval, no focus or
// reconnect refetch, so a 1.x install pays exactly one session request.
export const useSession = () => {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: fetchSession,
    retry: shouldRetry,
    refetchInterval: (query) => (isDisabled(query) ? false : SESSION_REFRESH_MS),
    refetchOnWindowFocus: (query) => !isDisabled(query),
    refetchOnReconnect: (query) => !isDisabled(query),
  });
};

export const useSignOut = (loginScope: LoginScope) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: signOut,
    // A session refetch still in flight must not overwrite the signed out answer.
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: SESSION_KEY });
    },
    onSuccess: () => {
      queryClient.setQueryData<DebugItSession>(SESSION_KEY, { state: 'signed-out', loginScope });
    },
  });
};
