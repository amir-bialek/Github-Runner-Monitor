import { useQuery } from '@tanstack/react-query';
import { fetchScaleSets } from '../services/api';
import { RUNNERS_REFRESH_MS } from '../appConfig';

export const useScaleSets = () => {
  return useQuery({
    queryKey: ['scale-sets'],
    queryFn: fetchScaleSets,
    refetchInterval: RUNNERS_REFRESH_MS,
  });
};
