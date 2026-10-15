import { ApiError } from '../api.js';
export function Failure({ error, retry }: { error: Error | null; retry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="notice error">
      <p>{error.message}</p>
      {error instanceof ApiError && <small>Reference: {error.detail.requestId}</small>}
      {retry && (
        <p>
          <button className="secondary" onClick={retry}>
            Try again
          </button>
        </p>
      )}
    </div>
  );
}
