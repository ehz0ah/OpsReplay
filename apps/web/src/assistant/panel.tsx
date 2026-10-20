import { Button, Textarea } from '@mantine/core';
import { useEffect, useRef, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { parseMutation } from '../../../../packages/contracts/public-validation.js';
import { useAuth } from '../auth/provider.js';
import { useApi } from '../api-context.js';
import { useAlive } from '../use-alive.js';
import { ApiError } from '../api.js';
import { streamAssistant } from './stream.js';
export function AssistantPanel({ id }: { id: string }) {
  const auth = useAuth(),
    api = useApi(),
    alive = useAlive();
  const stream = useRef<AbortController | null>(null);
  const finished = useRef(false);
  useEffect(() => () => stream.current?.abort(), []);
  const key = 'opsreplay:assistant:' + auth.identity?.sub + ':' + id;
  const [pending, setPending] = useState<PublicTypes['MessageRequest'] | null>(() => {
    try {
      const value = sessionStorage.getItem(key);
      return value ? parseMutation('MessageRequest', JSON.parse(value)) : null;
    } catch {
      return null;
    }
  });
  const [text, setText] = useState(''),
    [answer, setAnswer] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const [turn, setTurn] = useState<PublicTypes['Turn'] | null>(null);
  function saved(value: PublicTypes['Turn']) {
    setTurn(value);
    if (value.status !== 'running') finished.current = true;
    if (value.status === 'completed') {
      setAnswer(value.text);
      try {
        sessionStorage.removeItem(key);
      } catch {}
      setPending(null);
    } else if (value.status !== 'running') {
      setAnswer('');
      try {
        sessionStorage.removeItem(key);
      } catch {}
      setPending(null);
      setMessage(
        value.status === 'interrupted'
          ? 'The turn expired. Send a new question.'
          : 'The assistant did not finish. You can continue investigating.',
      );
    }
  }
  useEffect(() => {
    if (!pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 70000;
    const poll = async () => {
      let terminal = false;
      try {
        const value = await api.read('Turn', `/v1/sessions/${id}/messages/${pending.requestId}`, controller.signal);
        if (!controller.signal.aborted) {
          saved(value);
          terminal = value.status !== 'running';
        }
      } catch {
        /* Keep the same request ID if admission or the saved read is uncertain. */
      }
      if (!controller.signal.aborted && !terminal && Date.now() < deadline) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, id, key, pending?.requestId]);
  async function send() {
    if (busy || !auth.identity) return;
    setBusy(true);
    setMessage(null);
    setAnswer('');
    setTurn(null);
    finished.current = false;
    const controller = new AbortController();
    stream.current = controller;
    try {
      const request = pending ?? parseMutation('MessageRequest', { requestId: crypto.randomUUID(), text: text.trim() });
      sessionStorage.setItem(key, JSON.stringify(request));
      setPending(request);
      const token = await auth.session.token();
      if (!token) throw new Error('Sign in again to ask a question.');
      await streamAssistant(
        api.baseUrl,
        token,
        id,
        request,
        (event) => {
          if (!alive.current || controller.signal.aborted || finished.current) return;
          if (event.type === 'text_delta') setAnswer((value) => value + event.data.text);
          if (event.type === 'turn_completed') saved(event.data);
          if (event.type === 'turn_failed') setMessage(event.data.message);
        },
        AbortSignal.any([controller.signal, AbortSignal.timeout(70000)]),
      );
    } catch (error) {
      if (alive.current && !controller.signal.aborted && !finished.current) {
        setMessage(error instanceof Error ? error.message : 'Assistant unavailable.');
        if (
          error instanceof ApiError &&
          ['ASSISTANT_UNAVAILABLE', 'INVALID_REQUEST', 'NOT_FOUND', 'LIMIT_EXCEEDED'].includes(error.detail.code)
        ) {
          try {
            sessionStorage.removeItem(key);
          } catch {}
          setPending(null);
        }
      }
    } finally {
      if (alive.current && !controller.signal.aborted) setBusy(false);
      if (stream.current === controller) stream.current = null;
    }
  }
  return (
    <section className="assistant-panel">
      <h2>Investigation assistant</h2>
      <p className="muted">
        Ask about your recorded output or metrics. Replies can be wrong. Check the evidence before acting.
      </p>
      <p className="muted">
        Questions, recent chat, Challenge details, recorded commands and output, visible metrics, and released hints go
        to the configured AI provider. Do not include secrets or personal data.
      </p>
      <Textarea
        label="Your question"
        value={text}
        disabled={busy || !!pending}
        maxLength={4000}
        minRows={3}
        autosize
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <div className="actions">
        <Button disabled={busy || (!pending && !text.trim())} onClick={() => void send()}>
          {busy ? 'Answering…' : pending ? 'Recover question' : 'Ask'}
        </Button>
      </div>
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {pending && !busy && (
        <p className="muted">
          The connection ended before the reply was saved. Recover this question to check its result.
        </p>
      )}
      {answer && (
        <div className="assistant-answer" aria-live="polite">
          <p>{answer}</p>
          {turn?.status !== 'completed' && <p className="muted">Reply in progress. It is not yet a saved result.</p>}
        </div>
      )}
    </section>
  );
}
