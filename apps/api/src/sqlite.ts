import Database from 'better-sqlite3';
import type { LogicalEvent, SessionSummary } from '@opsreplay/contracts';
import type { ActionRecord, EngineState, SavedCheckpoint } from '@opsreplay/engine';
import type {
  Commit,
  EventBatch,
  Receipt,
  SavedResult,
  SessionRecord,
  SessionRepository,
} from './repository.js';
import { ApiError } from './errors.js';
import { boundedJson } from './validation.js';

type StoredState = Omit<EngineState, 'evidence' | 'checkpoints'>;
interface Row {
  owner_id: string;
  created_at: string;
  updated_at: string;
  data: string;
}
interface JsonRow {
  data: string;
}
interface ReceiptRow {
  scope: string;
  request_id: string;
  payload_hash: string;
  session_id: string;
  executed_version: number;
}

/** Local adapter. Every method completes its synchronous SQLite work before returning. */
export class SqliteRepository implements SessionRepository {
  private readonly db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename, { timeout: 3000 });
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('foreign_keys = ON');
      const version = this.db.pragma('user_version', { simple: true });
      if (version !== 0 && version !== 1) throw new Error('Unsupported local database version');
      if (version === 0)
        this.db
          .transaction(() => {
            this.db.exec(`
          CREATE TABLE sessions (
            key INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, owner_id TEXT NOT NULL,
            version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL
          );
          CREATE INDEX sessions_owner_key ON sessions(owner_id, key DESC);
          CREATE TABLE receipts (
            owner_id TEXT NOT NULL, scope TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(id), executed_version INTEGER NOT NULL,
            PRIMARY KEY(owner_id, scope, request_id)
          );
          CREATE TABLE batches (
            session_id TEXT NOT NULL REFERENCES sessions(id), version INTEGER NOT NULL, data TEXT NOT NULL,
            PRIMARY KEY(session_id, version)
          );
          CREATE TABLE events (
            session_id TEXT NOT NULL REFERENCES sessions(id), sequence INTEGER NOT NULL,
            version INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(session_id, sequence)
          );
          CREATE INDEX events_version ON events(session_id, version, sequence);
          CREATE TABLE observations (
            session_id TEXT NOT NULL REFERENCES sessions(id), evidence_id TEXT NOT NULL, data TEXT NOT NULL,
            PRIMARY KEY(session_id, evidence_id)
          );
          CREATE TABLE checkpoints (
            session_id TEXT NOT NULL REFERENCES sessions(id), checkpoint_id TEXT NOT NULL, data TEXT NOT NULL,
            PRIMARY KEY(session_id, checkpoint_id)
          );
          CREATE TABLE grants (owner_id TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN (0, 1)));
          CREATE TABLE content_pins (id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(id, version));
          PRAGMA user_version = 1;
        `);
          })
          .immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  setAccess(ownerId: string, active: boolean): void {
    this.db
      .prepare(
        'INSERT INTO grants VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET active = excluded.active',
      )
      .run(ownerId, active ? 1 : 0);
  }

  pinContent(id: string, version: string, hash: string): void {
    this.db
      .transaction(() => {
        const row = this.db
          .prepare<[string, string], { hash: string }>(
            'SELECT hash FROM content_pins WHERE id = ? AND version = ?',
          )
          .get(id, version);
        if (row && row.hash !== hash)
          throw new Error(
            `Content ${id}@${version} changed. Create a new version or use a fresh local database.`,
          );
        if (!row)
          this.db.prepare('INSERT INTO content_pins VALUES (?, ?, ?)').run(id, version, hash);
      })
      .immediate();
  }

  hasAccess(ownerId: string): Promise<boolean> {
    return Promise.resolve(
      this.db
        .prepare<[string], { active: number }>('SELECT active FROM grants WHERE owner_id = ?')
        .get(ownerId)?.active === 1,
    );
  }

  private owned(ownerId: string, id: string): SessionRecord {
    const row = this.db
      .prepare<[string, string], Row>(
        'SELECT owner_id, created_at, updated_at, data FROM sessions WHERE id = ? AND owner_id = ?',
      )
      .get(id, ownerId);
    if (!row) throw new ApiError('NOT_FOUND', 'Session not found.');
    const state = JSON.parse(row.data) as StoredState;
    const evidence = this.db
      .prepare<[string], JsonRow>(
        'SELECT data FROM observations WHERE session_id = ? ORDER BY rowid',
      )
      .all(id)
      .map((entry) => JSON.parse(entry.data) as EngineState['evidence'][number]);
    const checkpoints = this.db
      .prepare<[string], JsonRow>(
        'SELECT data FROM checkpoints WHERE session_id = ? ORDER BY rowid',
      )
      .all(id)
      .map((entry) => JSON.parse(entry.data) as SavedCheckpoint);
    return {
      ownerId: row.owner_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      state: { ...state, evidence, checkpoints },
    };
  }

  getOwnedSession(ownerId: string, id: string): Promise<SessionRecord> {
    return Promise.resolve(this.db.transaction(() => this.owned(ownerId, id))());
  }

  private receipt(ownerId: string, scope: string, requestId: string): Receipt | null {
    const row = this.db
      .prepare<[string, string, string], ReceiptRow>(
        'SELECT * FROM receipts WHERE owner_id = ? AND scope = ? AND request_id = ?',
      )
      .get(ownerId, scope, requestId);
    return row
      ? {
          scope: row.scope,
          requestId: row.request_id,
          payloadHash: row.payload_hash,
          sessionId: row.session_id,
          executedVersion: row.executed_version,
        }
      : null;
  }

  getReceipt(ownerId: string, scope: string, requestId: string): Promise<Receipt | null> {
    return Promise.resolve(this.receipt(ownerId, scope, requestId));
  }

  commit(input: Commit): Promise<SavedResult> {
    const committed = this.db
      .transaction((): SavedResult => {
        const { ownerId, record, result, receipt, expectedVersion } = input;
        if (record.ownerId !== ownerId || receipt.sessionId !== record.state.id)
          throw new Error('Invalid commit identity');
        const previous = expectedVersion === null ? null : this.owned(ownerId, record.state.id);
        const parent = input.parent ? this.owned(ownerId, input.parent.id) : null;
        const saved = this.receipt(ownerId, receipt.scope, receipt.requestId);
        if (saved) {
          if (saved.payloadHash !== receipt.payloadHash)
            throw new ApiError('IDEMPOTENCY_CONFLICT', 'Request ID was used with different data.');
          return { record: this.owned(ownerId, saved.sessionId), receipt: saved, replayed: true };
        }
        if (previous && previous.state.version !== expectedVersion)
          throw new ApiError(
            'VERSION_CONFLICT',
            'Session changed. Refresh before choosing an action.',
            previous.state.version,
          );
        if (
          parent &&
          (parent.state.version !== input.parent?.version ||
            parent.state.status === 'active' ||
            parent.state.mode !== 'first_attempt')
        )
          throw new ApiError('REPLAY_UNAVAILABLE', 'Replay parent is no longer eligible.');
        const { evidence, checkpoints, ...state } = record.state;
        const data = boundedJson(state);
        boundedJson(result.events);
        const batch = boundedJson({ output: result.output, action: result.action });
        const observations = evidence.map((item) => ({ id: item.id, data: boundedJson(item) }));
        const checkpointRows = checkpoints.map((item) => ({
          id: item.id,
          data: boundedJson(item),
        }));
        if (expectedVersion === null) {
          this.db
            .prepare(
              'INSERT INTO sessions (id, owner_id, version, created_at, updated_at, data) VALUES (?, ?, ?, ?, ?, ?)',
            )
            .run(state.id, ownerId, state.version, record.createdAt, record.updatedAt, data);
        } else {
          if (state.version !== expectedVersion + 1) throw new Error('Invalid commit version');
          this.db
            .prepare(
              'UPDATE sessions SET version = ?, updated_at = ?, data = ? WHERE id = ? AND owner_id = ? AND version = ?',
            )
            .run(state.version, record.updatedAt, data, state.id, ownerId, expectedVersion);
        }
        this.db.prepare('INSERT INTO batches VALUES (?, ?, ?)').run(state.id, state.version, batch);
        const insertEvent = this.db.prepare('INSERT INTO events VALUES (?, ?, ?, ?)');
        for (const event of result.events)
          insertEvent.run(state.id, event.sequence, state.version, boundedJson(event));
        // Preserve the engine's observation order when replacing an older observation.
        this.db.prepare('DELETE FROM observations WHERE session_id = ?').run(state.id);
        const observation = this.db.prepare('INSERT INTO observations VALUES (?, ?, ?)');
        for (const item of observations) observation.run(state.id, item.id, item.data);
        const checkpoint = this.db.prepare(
          'INSERT INTO checkpoints VALUES (?, ?, ?) ON CONFLICT(session_id, checkpoint_id) DO NOTHING',
        );
        for (const item of checkpointRows) checkpoint.run(state.id, item.id, item.data);
        this.db
          .prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            ownerId,
            receipt.scope,
            receipt.requestId,
            receipt.payloadHash,
            state.id,
            receipt.executedVersion,
          );
        return { record: this.owned(ownerId, state.id), receipt, replayed: false };
      })
      .immediate();
    return Promise.resolve(committed);
  }

  getBatch(ownerId: string, id: string, version: number): Promise<EventBatch> {
    this.owned(ownerId, id);
    const row = this.db
      .prepare<[string, number], JsonRow>(
        'SELECT data FROM batches WHERE session_id = ? AND version = ?',
      )
      .get(id, version);
    if (!row) throw new Error('Missing committed event batch');
    const batch = JSON.parse(row.data) as Omit<EventBatch, 'events'>;
    const events = this.db
      .prepare<[string, number], JsonRow>(
        'SELECT data FROM events WHERE session_id = ? AND version = ? ORDER BY sequence',
      )
      .all(id, version)
      .map((event) => JSON.parse(event.data) as LogicalEvent);
    return Promise.resolve({ ...batch, events });
  }

  listEvents(ownerId: string, id: string, after: number, limit: number): Promise<LogicalEvent[]> {
    this.owned(ownerId, id);
    return Promise.resolve(
      this.db
        .prepare<[string, number, number], JsonRow>(
          'SELECT data FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?',
        )
        .all(id, after, limit)
        .map((row) => JSON.parse(row.data) as LogicalEvent),
    );
  }

  listSessions(
    ownerId: string,
    before: number | null,
    limit: number,
  ): Promise<{ key: number; summary: SessionSummary }[]> {
    const rows = this.db
      .prepare<[string, number, number], Row & { key: number }>(
        'SELECT key, owner_id, created_at, updated_at, data FROM sessions WHERE owner_id = ? AND key < ? ORDER BY key DESC LIMIT ?',
      )
      .all(ownerId, before ?? Number.MAX_SAFE_INTEGER, limit);
    return Promise.resolve(
      rows.map((row) => {
        const state = JSON.parse(row.data) as StoredState;
        return {
          key: row.key,
          summary: {
            id: state.id,
            contentId: state.contentId,
            contentVersion: state.contentVersion,
            status: state.status,
            mode: state.mode,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          },
        };
      }),
    );
  }

  history(ownerId: string, id: string): Promise<ActionRecord[]> {
    this.owned(ownerId, id);
    const rows = this.db
      .prepare<[string], JsonRow>('SELECT data FROM batches WHERE session_id = ? ORDER BY version')
      .all(id);
    return Promise.resolve(
      rows.flatMap((row) => {
        const batch = JSON.parse(row.data) as Omit<EventBatch, 'events'>;
        return batch.action ? [batch.action] : [];
      }),
    );
  }
}
