import type { Error as ApiError } from '@opsreplay/contracts';

export class EngineError extends Error {
  constructor(
    public readonly code: ApiError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export class DefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DefinitionError';
  }
}

export function requireDefinition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DefinitionError(message);
}
