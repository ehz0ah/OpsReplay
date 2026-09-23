import type { LogicalEvent, SessionSummary } from '@opsreplay/contracts';
import type { ActionRecord, EngineResult, EngineState } from '@opsreplay/engine';

export interface SessionRecord {
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  state: EngineState;
}
export interface Receipt {
  scope: string;
  requestId: string;
  payloadHash: string;
  sessionId: string;
  executedVersion: number;
}
export interface Commit {
  ownerId: string;
  record: SessionRecord;
  result: EngineResult;
  receipt: Receipt;
  expectedVersion: number | null;
  parent?: { id: string; version: number };
}
export interface SavedResult {
  record: SessionRecord;
  receipt: Receipt;
  replayed: boolean;
}
export interface EventBatch {
  events: LogicalEvent[];
  output: EngineResult['output'];
  action: ActionRecord | null;
}
export interface SessionRepository {
  getOwnedSession(ownerId: string, id: string): Promise<SessionRecord>;
  getReceipt(ownerId: string, scope: string, requestId: string): Promise<Receipt | null>;
  commit(input: Commit): Promise<SavedResult>;
  getBatch(ownerId: string, id: string, version: number): Promise<EventBatch>;
  listEvents(ownerId: string, id: string, after: number, limit: number): Promise<LogicalEvent[]>;
  listSessions(
    ownerId: string,
    before: number | null,
    limit: number,
  ): Promise<{ key: number; summary: SessionSummary }[]>;
  history(ownerId: string, id: string): Promise<ActionRecord[]>;
  hasAccess(ownerId: string): Promise<boolean>;
}
