import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { read, sessionPath } from './client.js';
import { useOwner } from './owner.js';

export function useSession(id: string) {
  const owner = useOwner();
  return useQuery({
    queryKey: ['session', id],
    queryFn: () => read('SessionView', sessionPath(id), undefined, owner),
  });
}
export function useEvents(id: string) {
  const owner = useOwner();
  return useInfiniteQuery({
    queryKey: ['events', id],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      read(
        'EventPage',
        sessionPath(id) +
          '/events?limit=100' +
          (pageParam ? '&cursor=' + encodeURIComponent(pageParam) : ''),
        undefined,
        owner,
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
export function useCatalog() {
  return useInfiniteQuery({
    queryKey: ['catalog'],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      read(
        'Catalog',
        '/v1/catalog?mode=challenge&limit=100' +
          (pageParam ? '&cursor=' + encodeURIComponent(pageParam) : ''),
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
}
