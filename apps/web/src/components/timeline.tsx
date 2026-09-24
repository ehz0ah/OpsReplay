import { Button } from '@mantine/core';
import { useEvents } from '../api/queries.js';
import { clock, Failure, Loading } from './common.js';

export function Timeline({ id, tickSeconds }: { id: string; tickSeconds: number }) {
  const query = useEvents(id);
  if (query.isPending) return <Loading label="Loading history" />;
  if (query.isError)
    return (
      <Failure
        error={query.error}
        retry={() => {
          void query.refetch();
        }}
      />
    );
  const events = query.data.pages
    .flatMap((page) => page.items)
    .filter((event) => event.kind !== 'action_started' && event.kind !== 'observation');
  return (
    <>
      <ol className="timeline">
        {events.map((event) => (
          <li key={event.sequence} className={'event-' + event.kind}>
            <time>{clock(event.tick, tickSeconds)}</time>
            <p>{event.message}</p>
          </li>
        ))}
      </ol>
      {query.hasNextPage && (
        <Button
          variant="subtle"
          loading={query.isFetchingNextPage}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          Load more history
        </Button>
      )}
    </>
  );
}
