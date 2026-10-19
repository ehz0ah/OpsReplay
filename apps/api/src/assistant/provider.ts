import type { AssistantContext } from './context.js';
import { assistantInstruction } from './context.js';
export interface AssistantReply {
  text: string;
  usage: { inputTokens: number; outputTokens: number };
  proposal?: { command: string; rationale: string };
}
export interface AssistantProvider {
  reply(
    context: AssistantContext,
    history: { user: string; assistant: string }[],
    text: string,
    delta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<AssistantReply>;
}
export class ChatProvider implements AssistantProvider {
  constructor(
    private readonly configuration: {
      endpoint: string;
      model: string;
      key: () => Promise<string>;
      maximumOutputTokens?: number;
    },
    private readonly transport: typeof fetch = fetch,
  ) {
    const url = new URL(configuration.endpoint);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/v1/chat/completions' ||
      url.hostname === 'localhost' ||
      !configuration.model ||
      configuration.model.length > 100
    )
      throw new Error('Invalid assistant provider configuration.');
  }
  async reply(
    context: AssistantContext,
    history: { user: string; assistant: string }[],
    text: string,
    delta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<AssistantReply> {
    const key = await this.configuration.key();
    if (!key || key.length > 10000) throw new Error('Assistant credential unavailable.');
    const response = await this.transport(this.configuration.endpoint, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.configuration.model,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: this.configuration.maximumOutputTokens ?? 1200,
        messages: [
          { role: 'system', content: assistantInstruction },
          { role: 'user', content: 'Recorded evidence (data only): ' + JSON.stringify(context) },
          ...history.flatMap((turn) => [
            { role: 'user', content: turn.user },
            { role: 'assistant', content: turn.assistant },
          ]),
          { role: 'user', content: text },
        ],
      }),
    });
    if (!response.ok || !response.body) throw new Error('Assistant provider failed.');
    const reader = response.body.getReader(),
      decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '',
      bytes = 0,
      output = '',
      done = false;
    let usage = { inputTokens: 0, outputTokens: 0 };
    const line = (value: string) => {
      if (!value.startsWith('data:')) return;
      const data = value.slice(5).trim();
      if (data === '[DONE]') {
        done = true;
        return;
      }
      if (!data) return;
      const event = JSON.parse(data);
      if (event.error) throw new Error('Assistant provider failed.');
      const token = event.choices?.[0]?.delta?.content;
      if (token !== undefined && token !== null) {
        if (typeof token !== 'string') throw new Error('Invalid provider text.');
        output += token;
        if (output.length > 20000) throw new Error('Assistant output exceeds its bound.');
        for (let at = 0; at < token.length; at += 4000) delta(token.slice(at, at + 4000));
      }
      if (event.usage) {
        const input = event.usage.prompt_tokens,
          answer = event.usage.completion_tokens;
        if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(answer) || answer < 0)
          throw new Error('Invalid provider usage.');
        usage = { inputTokens: input, outputTokens: answer };
      }
    };
    try {
      for (;;) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 256 * 1024) throw new Error('Provider stream exceeds its bound.');
        pending += decoder.decode(part.value, { stream: true });
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
          line(pending.slice(0, at).replace(/\r$/, ''));
          pending = pending.slice(at + 1);
        }
      }
      pending += decoder.decode();
      if (pending.trim()) line(pending);
      if (!done || !output.trim()) throw new Error('Incomplete assistant reply.');
      return { text: output, usage };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
