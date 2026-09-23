import { randomUUID } from 'node:crypto';
import type {
  ActionRequest,
  ActionResponse,
  ReplayRequest,
  SessionResponse,
  StartSessionRequest,
  VersionedRequest,
} from '@opsreplay/contracts';
import { compare, debrief, end, project, replay, start, step } from '@opsreplay/engine';
import type { EngineResult } from '@opsreplay/engine';
import type { Receipt, SavedResult, SessionRecord, SessionRepository } from './repository.js';
import type { ContentRepository } from './content.js';
import { ApiError } from './errors.js';
import { hash, output } from './validation.js';

export class Sessions {
  constructor(
    readonly repository: SessionRepository,
    readonly content: ContentRepository,
  ) {}

  private async access(owner: string): Promise<void> {
    if (!(await this.repository.hasAccess(owner)))
      throw new ApiError('ACCESS_DENIED', 'Practice access is required.');
  }

  view(record: SessionRecord) {
    return output(
      'SessionView',
      project(this.content.get(record.state.contentId, record.state.contentVersion), record.state),
    );
  }

  private version(record: SessionRecord, expected: number): void {
    if (record.state.version !== expected)
      throw new ApiError(
        'VERSION_CONFLICT',
        'Session changed. Refresh before choosing an action.',
        record.state.version,
      );
  }

  private async receipt(
    owner: string,
    scope: string,
    requestId: string,
    payloadHash: string,
  ): Promise<SavedResult | null> {
    const saved = await this.repository.getReceipt(owner, scope, requestId);
    if (!saved) return null;
    if (saved.payloadHash !== payloadHash)
      throw new ApiError('IDEMPOTENCY_CONFLICT', 'Request ID was used with different data.');
    return {
      record: await this.repository.getOwnedSession(owner, saved.sessionId),
      receipt: saved,
      replayed: true,
    };
  }

  private response(saved: SavedResult): SessionResponse {
    return output('SessionResponse', {
      requestId: saved.receipt.requestId,
      replayed: saved.replayed,
      session: this.view(saved.record),
    });
  }

  async create(owner: string, request: StartSessionRequest): Promise<SessionResponse> {
    const payloadHash = hash({ operation: 'start', ...request });
    const saved = await this.receipt(owner, 'create', request.requestId, payloadHash);
    if (saved) return this.response(saved);
    await this.access(owner);
    const scenario = this.content.get(request.contentId, request.contentVersion);
    const result = start(scenario, randomUUID());
    const now = new Date().toISOString();
    const record: SessionRecord = {
      ownerId: owner,
      createdAt: now,
      updatedAt: now,
      state: result.state,
    };
    this.view(record);
    return this.response(
      await this.repository.commit({
        ownerId: owner,
        record,
        result,
        expectedVersion: null,
        receipt: {
          scope: 'create',
          requestId: request.requestId,
          payloadHash,
          sessionId: result.state.id,
          executedVersion: 0,
        },
      }),
    );
  }

  async get(owner: string, id: string) {
    return this.view(await this.repository.getOwnedSession(owner, id));
  }

  private async actionResponse(owner: string, saved: SavedResult): Promise<ActionResponse> {
    const batch = await this.repository.getBatch(
      owner,
      saved.record.state.id,
      saved.receipt.executedVersion,
    );
    return output('ActionResponse', {
      requestId: saved.receipt.requestId,
      replayed: saved.replayed,
      session: this.view(saved.record),
      output: batch.output,
      events: batch.events,
      executedVersion: saved.receipt.executedVersion,
    });
  }

  async action(owner: string, id: string, request: ActionRequest): Promise<ActionResponse> {
    const saved = await this.mutate(owner, id, 'action', request, (record) => {
      if (request.source !== 'direct')
        throw new ApiError(
          'PREREQUISITE_FAILED',
          'A valid stored proposal is required. Conversational actions are not enabled.',
        );
      return step(
        this.content.get(record.state.contentId, record.state.contentVersion),
        record.state,
        request.command,
        request.expectedVersion,
      );
    });
    return this.actionResponse(owner, saved);
  }

  async end(owner: string, id: string, request: VersionedRequest): Promise<SessionResponse> {
    return this.response(
      await this.mutate(owner, id, 'end', request, (record) =>
        end(
          this.content.get(record.state.contentId, record.state.contentVersion),
          record.state,
          request.expectedVersion,
        ),
      ),
    );
  }

  private async mutate(
    owner: string,
    id: string,
    operation: string,
    request: VersionedRequest,
    execute: (record: SessionRecord) => EngineResult,
  ): Promise<SavedResult> {
    const previous = await this.repository.getOwnedSession(owner, id);
    const payloadHash = hash({ operation, ...request });
    const saved = await this.receipt(owner, id, request.requestId, payloadHash);
    if (saved) return saved;
    this.version(previous, request.expectedVersion);
    await this.access(owner);
    const result = execute(previous);
    const record = { ...previous, state: result.state, updatedAt: new Date().toISOString() };
    this.view(record);
    const receipt: Receipt = {
      scope: id,
      requestId: request.requestId,
      payloadHash,
      sessionId: id,
      executedVersion: result.state.version,
    };
    return this.repository.commit({
      ownerId: owner,
      record,
      result,
      receipt,
      expectedVersion: request.expectedVersion,
    });
  }

  async replay(owner: string, id: string, request: ReplayRequest): Promise<SessionResponse> {
    const parent = await this.repository.getOwnedSession(owner, id);
    const payloadHash = hash({ operation: 'replay', parent: id, ...request });
    const saved = await this.receipt(owner, 'create', request.requestId, payloadHash);
    if (saved) return this.response(saved);
    this.version(parent, request.expectedVersion);
    await this.access(owner);
    const result = replay(parent.state, request.checkpointId, randomUUID());
    const now = new Date().toISOString();
    const record = { ownerId: owner, createdAt: now, updatedAt: now, state: result.state };
    this.view(record);
    return this.response(
      await this.repository.commit({
        ownerId: owner,
        record,
        result,
        expectedVersion: null,
        parent: { id, version: parent.state.version },
        receipt: {
          scope: 'create',
          requestId: request.requestId,
          payloadHash,
          sessionId: result.state.id,
          executedVersion: 0,
        },
      }),
    );
  }

  async debrief(owner: string, id: string) {
    const record = await this.repository.getOwnedSession(owner, id);
    return output(
      'Debrief',
      debrief(
        this.content.get(record.state.contentId, record.state.contentVersion),
        record.state,
        await this.repository.history(owner, id),
      ),
    );
  }

  async compare(owner: string, id: string) {
    const child = await this.repository.getOwnedSession(owner, id);
    const parentId = child.state.replayOrigin?.parentSessionId;
    if (!parentId) throw new ApiError('REPLAY_UNAVAILABLE', 'This attempt is not a replay.');
    const parent = await this.repository.getOwnedSession(owner, parentId);
    return output('Comparison', compare(parent.state, child.state));
  }
}
