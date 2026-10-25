import { parseMutation } from '../../../packages/contracts/public-validation.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
import { ApiError } from './api.js';
export type PendingMutation =
  | { kind: 'start'; path: '/v1/sessions'; body: PublicTypes['StartSessionRequest'] }
  | { kind: 'end' | 'hint' | 'upgrade'; path: string; body: PublicTypes['MutationRequest'] };
export class MutationJournal {
  constructor(
    private readonly storage: Storage,
    private readonly owner: string,
  ) {}
  private key(kind: PendingMutation['kind'], path: string) {
    return `opsreplay:pending:${this.owner}:${kind}:${path}`;
  }
  load(kind: PendingMutation['kind'], path: string): PendingMutation | null {
    const text = this.storage.getItem(this.key(kind, path));
    if (text === null || text === undefined) return null;
    try {
      if (text.length > 4096) throw new Error();
      const value = JSON.parse(text);
      if (Object.keys(value).length !== 3 || value.kind !== kind || value.path !== path) throw new Error();
      parseMutation(kind === 'start' ? 'StartSessionRequest' : 'MutationRequest', value.body);
      return value as PendingMutation;
    } catch {
      if (kind === 'upgrade')
        throw new Error(
          'The saved activation request could not be read. Refresh your account to check current access.',
        );
      throw new Error('The saved request could not be read. Resume your active attempt before starting another.');
    }
  }
  begin(value: PendingMutation): PendingMutation {
    parseMutation(value.kind === 'start' ? 'StartSessionRequest' : 'MutationRequest', value.body);
    const existing = this.load(value.kind, value.path);
    if (existing) {
      if (
        existing.kind === 'start' &&
        value.kind === 'start' &&
        (existing.body.challengeId !== value.body.challengeId ||
          existing.body.challengeVersion !== value.body.challengeVersion)
      )
        throw new Error('Resolve the previous request before starting another.');
      return existing;
    }
    this.storage.setItem(this.key(value.kind, value.path), JSON.stringify(value));
    return value;
  }
  complete(value: PendingMutation) {
    if (this.load(value.kind, value.path)?.body.requestId === value.body.requestId)
      this.storage.removeItem(this.key(value.kind, value.path));
  }
  reject(value: PendingMutation, error: unknown) {
    // Gateway correlation IDs cannot prove that an earlier request had no effect.
    if (
      error instanceof ApiError &&
      error.detail.requestId === value.body.requestId &&
      [
        'ACCESS_DENIED',
        'VERSION_UNAVAILABLE',
        'ACTIVE_SESSION_EXISTS',
        'LIMIT_EXCEEDED',
        'CAPACITY_UNAVAILABLE',
        'INVALID_REQUEST',
      ].includes(error.detail.code)
    )
      this.complete(value);
  }
}
