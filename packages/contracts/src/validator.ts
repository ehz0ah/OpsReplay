import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';
import type { ErrorObject } from 'ajv';

export function createValidator() {
  return new Ajv2020({
    strict: true,
    allowUnionTypes: true,
    allErrors: false,
    ownProperties: true,
    formats: fullFormats,
  });
}

export interface ValidationIssue {
  path: string;
  keyword: string;
  message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

// Copy safe details before AJV reuses its error buffer. Never echo input values.
export function issuesFrom(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map(({ instancePath, keyword, message }) => ({
    path: instancePath,
    keyword,
    message: message ?? 'Invalid value',
  }));
}
