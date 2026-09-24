import { createContext, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Alert, Button, Group } from '@mantine/core';
import { RequestError } from './client.js';
import { deliver, isDefinitiveRejection } from './deliver.js';
import { RequestJournal } from './journal.js';
import type { PendingRequest } from './journal.js';

interface Writer {
  busy: boolean;
  submit: (request: PendingRequest) => void;
}
const Context = createContext<Writer | null>(null);
export function useWriter() {
  const writer = useContext(Context);
  if (!writer) throw new Error('Mutation provider is missing.');
  return writer;
}

export function MutationProvider({
  ownerId,
  onIdentityChanged,
  children,
}: {
  ownerId: string;
  onIdentityChanged: () => void;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [journal] = useState(() => new RequestJournal(sessionStorage, ownerId));
  const [pending, setPending] = useState(() => journal.load());
  const active = useRef(false);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');

  async function execute(value: PendingRequest) {
    if (active.current) return;
    active.current = true;
    setSending(true);
    setMessage('');
    try {
      const result = await deliver(ownerId, value);
      journal.clear();
      setPending(null);
      client.setQueryData(['session', result.session.id], result.session);
      await client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'account' });
      if (value.kind === 'start' || value.kind === 'replay')
        void navigate('/challenges/' + result.session.id);
      if ('output' in result) setMessage(result.output.summary);
    } catch (error) {
      // A failed response can follow a committed write. Retain its exact receipt key.
      if (error instanceof RequestError && error.code === 'UNAUTHENTICATED') onIdentityChanged();
      if (isDefinitiveRejection(error)) {
        journal.clear();
        setPending(null);
        setMessage(
          error.code === 'VERSION_CONFLICT'
            ? 'This attempt changed in another tab. Refresh the current state and review it before choosing another action.'
            : error.message,
        );
        await client.invalidateQueries();
      } else {
        setMessage(error instanceof Error ? error.message : 'The result could not be confirmed.');
      }
    } finally {
      active.current = false;
      setSending(false);
    }
  }

  function submit(value: PendingRequest) {
    if (active.current || pending) return;
    try {
      journal.save(value);
      setPending(value);
      void execute(value);
    } catch {
      setMessage('Browser storage is unavailable. Enable storage before taking an action.');
    }
  }

  return (
    <Context value={{ busy: pending !== null || sending, submit }}>
      {pending && (
        <Alert
          color="orange"
          className="request-notice"
          title={sending ? 'Saving action' : 'An action needs recovery'}
          role="status"
        >
          <Group justify="space-between">
            <span>
              {pending.label}.{' '}
              {sending
                ? 'Waiting for the server.'
                : 'Its result is not confirmed. Retry the same request to recover it safely.'}
            </span>
            <Button
              variant="default"
              size="xs"
              loading={sending}
              onClick={() => {
                void execute(pending);
              }}
            >
              Retry saved request
            </Button>
          </Group>
        </Alert>
      )}
      {message && (
        <Alert
          className="request-notice"
          color={pending ? 'orange' : 'gray'}
          role="status"
          withCloseButton
          closeButtonLabel="Dismiss message"
          onClose={() => setMessage('')}
        >
          {message}
        </Alert>
      )}
      {children}
    </Context>
  );
}
