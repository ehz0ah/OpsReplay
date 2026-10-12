import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import publicSchema from '../../contracts/schemas/public.schema.json';
import type { Debrief } from './debrief.js';
import type { RecordedEvidence } from './recorded-evidence.js';
export interface PlaybackHighlight {
  kind: 'key_evidence' | 'possible_harmful_action' | 'outage' | 'recovery';
  at: string;
  commandSeq: number | null;
  label: string;
}
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const valid = ajv.compile<PlaybackHighlight[]>({ $ref: `${publicSchema.$id}#/$defs/Playback/properties/highlights` });
export function isPlaybackHighlights(value: unknown): value is PlaybackHighlight[] {
  return valid(value);
}
/** Timing and saved output support reflection, never asserted command causality. */
export function playbackHighlights(debrief: Debrief, evidence: RecordedEvidence): PlaybackHighlight[] {
  return [
    ...debrief.keyEvidence.flatMap((v) => {
      const command = evidence.commands.find((c) => c.seq === v.commandSeq);
      return v.status === 'observed' && command
        ? [
            {
              kind: 'key_evidence' as const,
              at: command.at,
              commandSeq: v.commandSeq,
              label: v.description.slice(0, 200),
            },
          ]
        : [];
    }),
    ...debrief.outages.map((v) => ({ kind: 'outage' as const, at: v.startedAt, commandSeq: null, label: v.label })),
    ...debrief.possibleHarmfulActions.flatMap((v) => {
      const command = evidence.commands.find((c) => c.seq === v.commandSeq);
      return command
        ? [
            {
              kind: 'possible_harmful_action' as const,
              at: command.at,
              commandSeq: v.commandSeq,
              label: v.description.slice(0, 200),
            },
          ]
        : [];
    }),
    ...evidence.events
      .filter((v) => v.signal === 'recovery_sustaining')
      .slice(-1)
      .map((v) => ({ kind: 'recovery' as const, at: v.at, commandSeq: null, label: v.label })),
  ]
    .sort(
      (a, b) => a.at.localeCompare(b.at) || a.kind.localeCompare(b.kind) || (a.commandSeq ?? 0) - (b.commandSeq ?? 0),
    )
    .slice(0, 200);
}
