import publicSchema from '../schemas/public.schema.json' with { type: 'json' };
import type { PublicTypes } from './generated/public.js';
import { createValidator, issuesFrom } from './validator.js';
import type { ValidationResult } from './validator.js';

export type { ValidationIssue, ValidationResult } from './validator.js';

const ajv = createValidator();
ajv.addSchema(publicSchema);

export function validatePublic<K extends keyof PublicTypes>(
  name: K,
  value: unknown,
): ValidationResult<PublicTypes[K]> {
  const validate = ajv.getSchema<PublicTypes[K]>(`${publicSchema.$id}#/$defs/${name}`);
  if (!validate) throw new Error(`Missing public schema: ${name}`);
  if ('$async' in validate) throw new Error(`Public schema must be synchronous: ${name}`);
  return validate(value) ? { ok: true, value } : { ok: false, issues: issuesFrom(validate.errors) };
}
