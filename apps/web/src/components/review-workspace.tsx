import { Button, Modal, Textarea } from '@mantine/core';
import { Fragment, useMemo, useState } from 'react';
import type { PublicTypes } from '../../../../packages/contracts/public-types.js';
import { ReviewDraft, emptyReviewDraft, type ReviewDraftValue } from '../review-draft.js';

type Flag = PublicTypes['Flag'];
function sameLine(a: Pick<Flag, 'file' | 'side' | 'line'> | null, b: Pick<Flag, 'file' | 'side' | 'line'>) {
  return !!a && a.file === b.file && a.side === b.side && a.line === b.line;
}
export function ReviewWorkspace({
  exercise,
  owner,
  pending,
  busy,
  result,
  submit,
}: {
  exercise: PublicTypes['ReviewExercise'];
  owner: string;
  pending: PublicTypes['ReviewSubmitRequest'] | null;
  busy: boolean;
  result: PublicTypes['ReviewSubmission'] | null;
  submit: (flags: Flag[]) => void;
}) {
  const store = useMemo(() => new ReviewDraft(sessionStorage, owner, exercise), [owner, exercise]);
  const [initial] = useState(() => {
    try {
      return { draft: store.load(), error: null as string | null };
    } catch {
      return { draft: emptyReviewDraft(), error: 'Your saved draft could not be read. It has not been removed.' };
    }
  });
  const [draft, setDraft] = useState<ReviewDraftValue>(initial.draft);
  const [storageError, setStorageError] = useState(initial.error);
  const [confirming, setConfirming] = useState(false);
  const locked = !!pending || busy || !!result;
  const flags = result?.flags ?? pending?.flags ?? draft.flags;
  const added = exercise.files.reduce((n, file) => n + file.lines.filter((line) => line.kind === 'added').length, 0);
  const removed = exercise.files.reduce(
    (n, file) => n + file.lines.filter((line) => line.kind === 'removed').length,
    0,
  );
  function update(value: ReviewDraftValue) {
    setDraft(value);
    try {
      store.save(value);
      setStorageError(null);
    } catch {
      setStorageError('Draft could not be saved in this browser. Keep this page open to retain your comments.');
    }
  }
  function select(flag: Pick<Flag, 'file' | 'side' | 'line'>) {
    if (locked || draft.editor) return;
    update({ ...draft, editor: { ...flag, concern: '' }, editingIndex: null });
  }
  function saveComment() {
    if (!draft.editor || !draft.editor.concern.trim()) return;
    const flag = { ...draft.editor, concern: draft.editor.concern.trim() };
    const next = [...draft.flags];
    if (draft.editingIndex === null) next.push(flag);
    else next[draft.editingIndex] = flag;
    update({ flags: next, editor: null, editingIndex: null });
  }
  return (
    <div className="review-workspace">
      <Modal
        opened={confirming}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
        title="Submit this review?"
        centered
      >
        <p>
          {flags.length
            ? `${flags.length} comment${flags.length === 1 ? '' : 's'} will be submitted.`
            : 'You have not added any comments.'}
        </p>
        <p>
          Submission reveals the reference findings. Line matches are checked; your written reasoning is not graded.
        </p>
        <div className="actions">
          <Button variant="default" onClick={() => setConfirming(false)}>
            Continue reviewing
          </Button>
          <Button
            loading={busy}
            onClick={() => {
              setConfirming(false);
              submit(flags);
            }}
          >
            Submit review
          </Button>
        </div>
      </Modal>
      <div className="review-toolbar">
        <div>
          <strong>Files changed</strong> <span className="muted">{exercise.files.length}</span>{' '}
          <span className="diff-stat-added">+{added}</span> <span className="diff-stat-removed">−{removed}</span>
        </div>
        <span>
          {flags.length} {flags.length === 1 ? 'comment' : 'comments'}
        </span>
        {!locked && (
          <span className="muted" role="status">
            {storageError ? 'Draft not saved' : 'Draft saved in this tab'}
          </span>
        )}
      </div>
      {storageError && (
        <p className="notice error" role="alert">
          {storageError}
        </p>
      )}
      <div className="review-layout">
        <aside className="review-sidebar" aria-label="Changed files">
          <nav>
            {exercise.files.map((file, index) => (
              <a href={`#review-file-${index}`} key={file.path}>
                {file.path}
              </a>
            ))}
          </nav>
          <p>
            {result
              ? 'This saved review is read-only. Your comments appear at their original lines.'
              : pending
                ? 'Recover this submission before you continue reviewing.'
                : 'Add a comment from a line number. Use Tab and Enter to review with a keyboard.'}
          </p>
          {!locked && draft.editor && (
            <p role="status">Save or cancel your comment before choosing another line or submitting.</p>
          )}
        </aside>
        <div className="review-files">
          {exercise.files.map((file, fileIndex) => (
            <section className="review-file" id={`review-file-${fileIndex}`} key={file.path}>
              <header className="review-file-header">
                <h2>{file.path}</h2>
                <span className="muted">Unified diff</span>
              </header>
              <div className="review-diff" role="region" aria-label={`Diff for ${file.path}`} tabIndex={0}>
                <div className="diff-row diff-heading">
                  <span>Before</span>
                  <span>After</span>
                  <span>Change</span>
                </div>
                {file.lines.map((line, row) => (
                  <Fragment key={row}>
                    <div className={`diff-row diff-${line.kind}`}>
                      {(['old', 'new'] as const).map((side) => {
                        const number = side === 'old' ? line.oldLine : line.newLine;
                        const location = { file: file.path, side, line: number! };
                        const count = flags.filter((flag) => sameLine(flag, location)).length;
                        return number === null ? (
                          <span className="diff-number" key={side} />
                        ) : (
                          <button
                            key={side}
                            className={`diff-number${count ? ' has-comment' : ''}`}
                            disabled={locked || !!draft.editor}
                            aria-label={`Add comment on ${file.path} ${side === 'old' ? 'before' : 'after'} line ${number}${count ? `, ${count} saved` : ''}`}
                            onClick={() => select(location)}
                          >
                            <span className="diff-comment-icon" aria-hidden="true">
                              {count ? '●' : '+'}
                            </span>
                            {number}
                          </button>
                        );
                      })}
                      <code>
                        <span aria-hidden="true">
                          {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                        </span>
                        {line.text}
                      </code>
                    </div>
                    {flags.map(
                      (flag, index) =>
                        flag.file === file.path &&
                        (flag.side === 'old' ? line.oldLine : line.newLine) === flag.line && (
                          <article className="inline-review-comment" key={`${flag.side}-${index}`}>
                            <div className="inline-comment-header">
                              <strong>Your comment</strong>
                              <span>
                                {flag.side === 'old' ? 'Before' : 'After'} · line {flag.line}
                              </span>
                            </div>
                            <p>{flag.concern}</p>
                            {!locked && (
                              <div className="actions">
                                <Button
                                  variant="subtle"
                                  size="xs"
                                  disabled={!!draft.editor}
                                  onClick={() => update({ ...draft, editor: { ...flag }, editingIndex: index })}
                                >
                                  Edit comment
                                </Button>
                                <Button
                                  variant="subtle"
                                  size="xs"
                                  disabled={!!draft.editor}
                                  onClick={() => update({ ...draft, flags: draft.flags.filter((_, i) => i !== index) })}
                                >
                                  Delete comment
                                </Button>
                              </div>
                            )}
                          </article>
                        ),
                    )}
                    {!locked &&
                      draft.editor &&
                      draft.editor.file === file.path &&
                      (draft.editor.side === 'old' ? line.oldLine : line.newLine) === draft.editor.line && (
                        <section className="inline-review-editor" aria-label="Comment editor">
                          <strong>
                            {draft.editingIndex === null ? 'New comment' : 'Edit comment'} ·{' '}
                            {draft.editor.side === 'old' ? 'Before' : 'After'} line {draft.editor.line}
                          </strong>
                          <Textarea
                            label="Your concern"
                            placeholder="Explain the failure this change could cause and how to avoid it."
                            value={draft.editor.concern}
                            maxLength={2000}
                            minRows={3}
                            autosize
                            autoFocus
                            onChange={(event) =>
                              update({ ...draft, editor: { ...draft.editor!, concern: event.currentTarget.value } })
                            }
                          />
                          <div className="actions">
                            <Button
                              size="sm"
                              disabled={
                                !draft.editor.concern.trim() ||
                                (draft.editingIndex === null && draft.flags.length >= 50)
                              }
                              onClick={saveComment}
                            >
                              Save comment
                            </Button>
                            <Button
                              variant="default"
                              size="sm"
                              onClick={() => update({ ...draft, editor: null, editingIndex: null })}
                            >
                              Cancel
                            </Button>
                          </div>
                        </section>
                      )}
                  </Fragment>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
      {!result && (
        <div className="review-submit-bar">
          <p>
            {pending
              ? 'Recover the saved submission. Its comments and request ID stay unchanged.'
              : 'Reference findings are revealed after submission. Written concerns are saved for reflection.'}
          </p>
          <Button
            loading={busy}
            disabled={busy || (!pending && !!draft.editor)}
            onClick={() => (pending ? submit(flags) : setConfirming(true))}
          >
            {pending ? 'Recover submission' : 'Submit review'}
          </Button>
        </div>
      )}
    </div>
  );
}
