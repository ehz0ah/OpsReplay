import * as requests from '../../.local/contracts/requests-validators.js';
import type { PublicTypes } from './public-types.js';
const entry = () => import('../../.local/contracts/entry-validators.js');
const session = () => import('../../.local/contracts/session-validators.js');
const assistant = () => import('../../.local/contracts/assistant-validators.js');
const reviews = () => import('../../.local/contracts/reviews-validators.js');
const results = () => import('../../.local/contracts/results-validators.js');
const loaders = {
  Error: entry,
  Catalog: entry,
  Account: entry,
  LearnEntry: entry,
  SessionPage: entry,
  Turn: assistant,
  StreamEvent: assistant,
  ReviewExercise: reviews,
  ReviewSubmission: reviews,
  ReviewSubmissionPage: reviews,
  SessionView: session,
  SessionResponse: session,
  EndSessionResponse: session,
  TerminalTicket: session,
  HintResponse: session,
  TimelinePage: session,
  GatewayClientMessage: session,
  GatewayServerMessage: session,
  Debrief: results,
  Playback: results,
  PlaybackMetrics: results,
  PlaybackCapture: results,
};
export type BrowserType = keyof typeof loaders;
export async function parsePublic<K extends BrowserType>(name: K, value: unknown): Promise<PublicTypes[K]> {
  const module: Record<string, unknown> = await loaders[name]();
  const guard = module[name];
  if (typeof guard !== 'function' || !guard(value))
    throw new Error('The server response does not match the public contract.');
  return value as PublicTypes[K];
}
export function parseMutation<K extends keyof typeof requests>(name: K, value: unknown): PublicTypes[K] {
  if (!requests[name](value)) throw new Error('The request does not match the public contract.');
  return value as PublicTypes[K];
}
