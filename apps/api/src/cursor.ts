import { createHmac, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.js';

export class CursorCodec {
  constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error('Cursor key must contain at least 32 characters');
  }

  encode(binding: string, position: number): string {
    const value = Buffer.from(JSON.stringify({ binding, position })).toString('base64url');
    return `${value}.${this.sign(value)}`;
  }

  decode(token: string | undefined, binding: string): number | null {
    if (token === undefined) return null;
    try {
      const [value, signature, extra] = token.split('.');
      if (!value || !signature || extra || token.length > 2000) throw new Error();
      const actual = Buffer.from(signature);
      const expected = Buffer.from(this.sign(value));
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
        throw new Error();
      const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        !('binding' in parsed) ||
        !('position' in parsed) ||
        parsed.binding !== binding ||
        typeof parsed.position !== 'number' ||
        !Number.isSafeInteger(parsed.position) ||
        parsed.position < 0
      )
        throw new Error();
      return parsed.position;
    } catch {
      throw new ApiError('INVALID_REQUEST', 'Invalid cursor for this resource or query.');
    }
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }
}
