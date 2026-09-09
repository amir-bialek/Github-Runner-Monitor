import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchQueue } from '../services/api';

export const useQueue = (scaleSet?: string) => {
  return useQuery({
    queryKey: ['jobs-queue', scaleSet ?? 'all'],
    queryFn: () => fetchQueue(scaleSet),
    placeholderData: keepPreviousData,
  });
};
