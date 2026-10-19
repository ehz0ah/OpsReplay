import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import reviewSchema from '../../contracts/schemas/review.schema.json';
import publicSchema from '../../contracts/schemas/public.schema.json';
import type { PublicTypes } from '../../contracts/public-types.js';
import { canonicalJson } from '../../session/src/canonical.js';
import type { CatalogEntry } from './catalogue.js';
export type ReviewExercise = PublicTypes['ReviewExercise'];
export type ReviewSubmission = PublicTypes['ReviewSubmission'];
export type ReviewRequest = PublicTypes['ReviewSubmitRequest'];
export interface ReviewBundle extends ReviewExercise {
  schemaVersion: '0.2';
  summary: string;
  status: 'draft' | 'published';
  provenance: {
    kind: 'synthetic' | 'adapted';
    notes: string;
    sources: { title: string; url: string; mechanism: string }[];
  };
  relatedChallenges: string[];
  findings: Omit<PublicTypes['ReviewFinding'], 'found' | 'matchedFlags'>[];
}
const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
addFormats(ajv);
ajv.addSchema(publicSchema);
const bundleSchema = ajv.compile<ReviewBundle>(reviewSchema);
export const isReviewExercise = ajv.compile<ReviewExercise>({ $ref: `${publicSchema.$id}#/$defs/ReviewExercise` });
export const isReviewRequest = ajv.compile<ReviewRequest>({ $ref: `${publicSchema.$id}#/$defs/ReviewSubmitRequest` });
export const isReviewSubmission = ajv.compile<ReviewSubmission>({
  $ref: `${publicSchema.$id}#/$defs/ReviewSubmission`,
});
export function isReviewBundle(value: unknown): value is ReviewBundle {
  if (!bundleSchema(value) || Buffer.byteLength(canonicalJson(value)) > 256 * 1024) return false;
  if (
    new Set(value.files.map((file) => file.path)).size !== value.files.length ||
    new Set(value.findings.map((finding) => finding.id)).size !== value.findings.length
  )
    return false;
  for (const file of value.files) {
    const old = new Set<number>(),
      current = new Set<number>();
    for (const line of file.lines) {
      if ((line.oldLine === null) !== (line.kind === 'added') || (line.newLine === null) !== (line.kind === 'removed'))
        return false;
      if (line.oldLine !== null) {
        if (old.has(line.oldLine)) return false;
        old.add(line.oldLine);
      }
      if (line.newLine !== null) {
        if (current.has(line.newLine)) return false;
        current.add(line.newLine);
      }
    }
  }
  return value.findings.every((finding) => {
    const file = value.files.find((file) => file.path === finding.file);
    if (!file || finding.startLine > finding.endLine || finding.endLine - finding.startLine > 2000) return false;
    const lines = new Set(file.lines.map((line) => (finding.side === 'new' ? line.newLine : line.oldLine)));
    for (let line = finding.startLine; line <= finding.endLine; line++) if (!lines.has(line)) return false;
    return true;
  });
}
export function exerciseView(bundle: ReviewBundle): ReviewExercise {
  return {
    id: bundle.id,
    version: bundle.version,
    title: bundle.title,
    tier: bundle.tier,
    category: bundle.category,
    plan: bundle.plan,
    language: bundle.language,
    context: bundle.context,
    files: structuredClone(bundle.files),
  };
}
export function reviewResult(bundle: ReviewBundle, flags: PublicTypes['Flag'][]) {
  if (!isReviewBundle(bundle)) throw new Error('Invalid review bundle.');
  for (const flag of flags) {
    const file = bundle.files.find((file) => file.path === flag.file);
    if (!file?.lines.some((line) => (flag.side === 'new' ? line.newLine : line.oldLine) === flag.line))
      throw new Error('Flag does not identify a diff line.');
  }
  const matched = new Set<number>();
  const findings = bundle.findings.map((finding) => {
    const matchedFlags = flags.flatMap((flag, index) =>
      flag.file === finding.file &&
      flag.side === finding.side &&
      flag.line >= finding.startLine &&
      flag.line <= finding.endLine
        ? [index]
        : [],
    );
    matchedFlags.forEach((index) => matched.add(index));
    return { ...finding, found: matchedFlags.length > 0, matchedFlags };
  });
  return {
    findings,
    unmatchedFlags: flags.map((_, index) => index).filter((index) => !matched.has(index)),
    summary: {
      found: findings.filter((finding) => finding.found).length,
      missed: findings.filter((finding) => !finding.found).length,
    },
  };
}
export const reviewKeys = {
  published: (id: string) => ({ PK: `CONTENT#code_review#${id}`, SK: 'PUBLISHED' }),
  version: (id: string, version: string) => ({ PK: `CONTENT#code_review#${id}`, SK: `VERSION#${version}` }),
  receipt: (owner: string, request: string) => ({ PK: `USER#${owner}`, SK: `REVIEWREQ#${request}` }),
  seen: (owner: string, id: string) => ({ PK: `USER#${owner}`, SK: `REVIEWSEEN#${id}` }),
  submission: (id: string) => ({ PK: `REVIEW#${id}`, SK: 'STATE' }),
};
export function prepareReview(bundle: ReviewBundle) {
  if (!isReviewBundle(bundle)) throw new Error('Invalid review content.');
  const published = { ...bundle, status: 'published' as const };
  const sha256 = createHash('sha256').update(canonicalJson(published)).digest('hex');
  const catalogue: CatalogEntry = {
    id: bundle.id,
    version: bundle.version,
    mode: 'code_review',
    title: bundle.title,
    summary: bundle.summary,
    category: bundle.category,
    tier: bundle.tier,
    language: bundle.language,
    plan: bundle.plan,
  };
  return { bundle: published, pointer: { version: bundle.version, sha256, plan: bundle.plan }, catalogue };
}
