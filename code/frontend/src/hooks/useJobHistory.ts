import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchJobHistory } from '../services/api';
import { HISTORY_LIMIT } from '../appConfig';

export const DEFAULT_HISTORY_LIMIT = HISTORY_LIMIT;

export const useJobHistory = (scaleSet?: string, limit: number = DEFAULT_HISTORY_LIMIT) => {
  return useQuery({
    queryKey: ['jobs-history', scaleSet ?? 'all', limit],
    queryFn: () => fetchJobHistory(scaleSet, limit),
    placeholderData: keepPreviousData,
  });
};
