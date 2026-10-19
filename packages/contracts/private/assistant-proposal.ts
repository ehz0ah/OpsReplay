import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import schema from '../schemas/public.schema.json';
import { randomUUID } from 'node:crypto';
import type { PublicTypes } from '../public-types.js';
export interface SavedProposal {
  schemaVersion: 1;
  ownerId: string;
  sessionId: string;
  turnId: string;
  view: PublicTypes['Proposal'];
  delivery: { token: string; startedAt: string } | null;
}
/** Single-line shell text. This is a scope guard, not a shell sandbox. */
export function proposalCommand(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 1000 &&
    !!value.trim() &&
    !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    !/(?:\b(?:exit|logout|reboot|shutdown|poweroff)\b|\bkill\s+(?:-[A-Za-z0-9]+\s+)*1\b)/i.test(value)
  );
}
export function createProposal(value: unknown, expiresAt: string): PublicTypes['Proposal'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 2 ||
    !proposalCommand(v.command) ||
    typeof v.rationale !== 'string' ||
    !v.rationale.trim() ||
    v.rationale.length > 1000
  )
    return;
  return {
    id: randomUUID(),
    command: v.command,
    rationale: v.rationale,
    caution: /\b(?:rm|kill|systemctl|supervisorctl|service|restart|truncate|drop|delete|alter)\b/i.test(v.command),
    status: 'pending',
    expiresAt,
  };
}

const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(schema);
const validProposal = ajv.getSchema(schema.$id + '#/$defs/Proposal')!;
export function isSavedProposal(value: unknown): value is SavedProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as SavedProposal;
  return (
    Object.keys(v).length === 6 &&
    v.schemaVersion === 1 &&
    typeof v.ownerId === 'string' &&
    /^[a-f0-9-]{36}$/.test(v.sessionId) &&
    /^[a-f0-9-]{36}$/.test(v.turnId) &&
    validProposal(v.view) &&
    proposalCommand(v.view.command) &&
    (v.view.status === 'pending' || v.view.status === 'expired' ? v.delivery === null : v.delivery !== null) &&
    (v.delivery === null ||
      (typeof v.delivery === 'object' &&
        !Array.isArray(v.delivery) &&
        Object.keys(v.delivery).length === 2 &&
        /^[a-f0-9-]{36}$/.test(v.delivery.token) &&
        Number.isFinite(Date.parse(v.delivery.startedAt))))
  );
}
