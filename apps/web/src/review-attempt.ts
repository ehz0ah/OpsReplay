import { parseMutation } from '../../../packages/contracts/public-validation.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';
import { ApiClient, ApiError } from './api.js';
export class ReviewAttempt {
  constructor(
    private readonly storage: Storage,
    private readonly owner: string,
    private readonly exercise: string,
  ) {}
  private key() {
    return `opsreplay:review:${this.owner}:${this.exercise}`;
  }
  load(): PublicTypes['ReviewSubmitRequest'] | null {
    const text = this.storage.getItem(this.key());
    if (!text) return null;
    if (text.length > 128 * 1024) throw new Error('Saved review request exceeds its bound.');
    return parseMutation('ReviewSubmitRequest', JSON.parse(text));
  }
  begin(version: string, flags: PublicTypes['Flag'][]) {
    const saved = this.load();
    if (saved) return saved;
    const value = parseMutation('ReviewSubmitRequest', {
      requestId: crypto.randomUUID(),
      exerciseVersion: version,
      flags,
    });
    this.storage.setItem(this.key(), JSON.stringify(value));
    return value;
  }
  async submit(api: ApiClient, value: PublicTypes['ReviewSubmitRequest']) {
    const pending = this.load();
    if (!pending || pending.requestId !== value.requestId) throw new Error('Review request is not saved.');
    try {
      const result = await api.mutate('ReviewSubmission', `/v1/reviews/${this.exercise}/submissions`, pending);
      if (result.exerciseId !== this.exercise || result.exerciseVersion !== pending.exerciseVersion)
        throw new Error('Review result identity mismatch.');
      this.storage.removeItem(this.key());
      return result;
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.detail.requestId === pending.requestId &&
        ['INVALID_REQUEST', 'VERSION_UNAVAILABLE', 'PLAN_REQUIRED'].includes(error.detail.code)
      )
        this.storage.removeItem(this.key());
      throw error;
    }
  }
}
