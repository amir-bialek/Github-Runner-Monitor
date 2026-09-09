import { useQuery } from '@tanstack/react-query';
import { fetchRunners } from '../services/api';

export const useRunners = () => {
  return useQuery({
    queryKey: ['runners'],
    queryFn: fetchRunners,
  });
};
