import { useRead } from '../use-read.js';
import { Failure } from '../components/failure.js';
export function SessionEntry({ id }: { id: string }) {
  const session = useRead('SessionView', '/v1/sessions/' + id);
  return (
    <>
      <Failure error={session.error} retry={session.reload} />
      {session.loading && <p role="status">Reading your attempt…</p>}
      {session.data && (
        <section className="panel">
          <span className="badge">{session.data.status}</span>
          <h2>{session.data.challenge.title}</h2>
          <h3>{session.data.alert.title}</h3>
          <p>{session.data.alert.summary}</p>
          <p className="muted">
            {session.data.status === 'provisioning'
              ? 'The clock starts when the environment is ready.'
              : 'This attempt uses real time.'}
          </p>
          <button className="secondary" onClick={session.reload}>
            Refresh status
          </button>
        </section>
      )}
    </>
  );
}
