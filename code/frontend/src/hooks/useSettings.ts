import { useQuery } from '@tanstack/react-query';
import { fetchSettings } from '../services/api';

export const useSettings = () => {
  return useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: Infinity,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
};
