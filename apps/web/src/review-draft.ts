import { parseMutation } from '../../../packages/contracts/public-validation.js';
import type { PublicTypes } from '../../../packages/contracts/public-types.js';

type Exercise = PublicTypes['ReviewExercise'];
export interface ReviewDraftValue {
  flags: PublicTypes['Flag'][];
  editor: PublicTypes['Flag'] | null;
  editingIndex: number | null;
}
export const emptyReviewDraft = (): ReviewDraftValue => ({ flags: [], editor: null, editingIndex: null });

export function reviewLineExists(exercise: Exercise, flag: Pick<PublicTypes['Flag'], 'file' | 'side' | 'line'>) {
  return exercise.files.some(
    (file) =>
      file.path === flag.file &&
      file.lines.some((line) => (flag.side === 'old' ? line.oldLine : line.newLine) === flag.line),
  );
}

export class ReviewDraft {
  private readonly key: string;
  constructor(
    private readonly storage: Storage,
    owner: string,
    private readonly exercise: Exercise,
  ) {
    this.key = `opsreplay:review-draft:${owner}:${exercise.id}@${exercise.version}`;
  }
  private validate(value: ReviewDraftValue): ReviewDraftValue {
    const flags = parseMutation('ReviewSubmitRequest', {
      requestId: '00000000-0000-4000-8000-000000000000',
      exerciseVersion: this.exercise.version,
      flags: value.flags,
    }).flags;
    if (flags.some((flag) => !reviewLineExists(this.exercise, flag)))
      throw new Error('A saved comment refers to an unavailable line.');
    if (value.editor !== null) {
      if (!value.editor || typeof value.editor.concern !== 'string' || value.editor.concern.length > 2000)
        throw new Error('The saved comment text is invalid.');
      const editor = parseMutation('ReviewSubmitRequest', {
        requestId: '00000000-0000-4000-8000-000000000000',
        exerciseVersion: this.exercise.version,
        flags: [{ ...value.editor, concern: value.editor.concern || ' ' }],
      }).flags[0]!;
      if (!reviewLineExists(this.exercise, editor)) throw new Error('The saved editor refers to an unavailable line.');
    }
    if (
      value.editingIndex !== null &&
      (!Number.isInteger(value.editingIndex) || value.editingIndex < 0 || value.editingIndex >= flags.length)
    )
      throw new Error('The saved comment index is invalid.');
    if (
      value.editingIndex !== null &&
      (!value.editor ||
        ['file', 'side', 'line'].some(
          (key) =>
            value.editor![key as 'file' | 'side' | 'line'] !==
            flags[value.editingIndex!]![key as 'file' | 'side' | 'line'],
        ))
    )
      throw new Error('The saved editor does not match its comment.');
    return value;
  }
  load(): ReviewDraftValue {
    const text = this.storage.getItem(this.key);
    if (!text) return emptyReviewDraft();
    if (text.length > 128 * 1024) throw new Error('Saved review draft exceeds its bound.');
    const value = JSON.parse(text);
    if (!value || Object.keys(value).sort().join(',') !== 'editingIndex,editor,flags')
      throw new Error('Saved review draft is invalid.');
    return this.validate(value);
  }
  save(value: ReviewDraftValue) {
    this.validate(value);
    const text = JSON.stringify(value);
    if (text.length > 128 * 1024) throw new Error('Review draft exceeds its bound.');
    this.storage.setItem(this.key, text);
  }
  clear() {
    this.storage.removeItem(this.key);
  }
}
