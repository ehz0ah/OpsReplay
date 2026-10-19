import type { AssistantContext } from './context.js';
import { proposalCommand } from '../../../../packages/contracts/private/assistant-proposal.js';
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
        tools: [
          {
            type: 'function',
            function: {
              name: 'propose_command',
              description: 'Suggest one single-line shell command for learner confirmation. Never executes it.',
              strict: true,
              parameters: {
                type: 'object',
                additionalProperties: false,
                properties: { command: { type: 'string' }, rationale: { type: 'string' } },
                required: ['command', 'rationale'],
              },
            },
          },
        ],
        parallel_tool_calls: false,
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
    let toolName = '',
      toolArguments = '',
      toolId = '',
      invalidTool = false;
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
      const calls = event.choices?.[0]?.delta?.tool_calls;
      if (calls !== undefined) {
        if (!Array.isArray(calls) || calls.length > 1) invalidTool = true;
        else
          for (const call of calls) {
            if (call.index !== 0 || (call.id && toolId && call.id !== toolId)) invalidTool = true;
            if (typeof call.id === 'string') toolId = call.id;
            if (typeof call.function?.name === 'string') toolName += call.function.name;
            if (typeof call.function?.arguments === 'string') toolArguments += call.function.arguments;
            if (toolName.length > 100 || toolArguments.length > 8000)
              throw new Error('Provider tool exceeds its bound.');
          }
      }
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
      let proposal: AssistantReply['proposal'];
      if (!invalidTool && toolName === 'propose_command') {
        try {
          const value = JSON.parse(toolArguments);
          if (
            value &&
            Object.keys(value).length === 2 &&
            proposalCommand(value.command) &&
            typeof value.rationale === 'string' &&
            value.rationale.trim() &&
            value.rationale.length <= 1000
          )
            proposal = value;
        } catch {}
      }
      if (!output.trim() && proposal) output = 'Review the proposed command before you confirm it.';
      if (!done || !output.trim()) throw new Error('Incomplete assistant reply.');
      return { text: output, usage, ...(proposal ? { proposal } : {}) };
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
