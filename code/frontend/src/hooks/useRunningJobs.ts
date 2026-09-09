import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchRunningJobs } from '../services/api';

export const useRunningJobs = (scaleSet?: string) => {
  return useQuery({
    queryKey: ['jobs-running', scaleSet ?? 'all'],
    queryFn: () => fetchRunningJobs(scaleSet),
    placeholderData: keepPreviousData,
  });
};
