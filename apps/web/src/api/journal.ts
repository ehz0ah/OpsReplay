import type {
  ActionRequest,
  ReplayRequest,
  StartSessionRequest,
  VersionedRequest,
} from '@opsreplay/contracts';
import { validatePublic } from '@opsreplay/contracts/validation';

export type PendingRequest =
  | { kind: 'start'; body: StartSessionRequest; label: string }
  | { kind: 'action'; sessionId: string; body: ActionRequest; label: string }
  | { kind: 'end'; sessionId: string; body: VersionedRequest; label: string }
  | { kind: 'replay'; sessionId: string; body: ReplayRequest; label: string };

// One outstanding write per browser tab and learner. Persist before dispatch.
export class RequestJournal {
  private readonly key: string;
  constructor(
    private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    ownerId: string,
  ) {
    this.key = 'opsreplay:pending:v1:' + ownerId;
  }
  load(): PendingRequest | null {
    const raw = this.storage.getItem(this.key);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      !('kind' in value) ||
      !('body' in value) ||
      !('label' in value) ||
      typeof value.label !== 'string'
    )
      throw new Error('Saved request is invalid.');
    const names = {
      start: 'StartSessionRequest',
      action: 'ActionRequest',
      end: 'VersionedRequest',
      replay: 'ReplayRequest',
    } as const;
    if (typeof value.kind !== 'string' || !Object.hasOwn(names, value.kind))
      throw new Error('Saved request is invalid.');
    const kind = value.kind as keyof typeof names;
    if (
      !validatePublic(names[kind], value.body).ok ||
      (kind !== 'start' &&
        (!('sessionId' in value) ||
          typeof value.sessionId !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(value.sessionId)))
    )
      throw new Error('Saved request is invalid.');
    return value as PendingRequest;
  }
  save(value: PendingRequest) {
    this.storage.setItem(this.key, JSON.stringify(value));
  }
  clear() {
    this.storage.removeItem(this.key);
  }
}
