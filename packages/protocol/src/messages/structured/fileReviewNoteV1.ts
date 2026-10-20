import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';

export const FILE_REVIEW_NOTE_KIND = 'file_review_note.v1' as const;

/** Content stays in the Session's ordinary encrypted/plain transcript envelope. */
export const FileReviewNoteV1Schema = lazyZodSchema(() => z.strictObject({
  action: z.enum(['discard', 'restore', 'undo']),
  paths: z.array(z.string().check(z.minLength(1))).check(z.minLength(1)),
  changeCount: z.optional(z.number().check(z.int(), z.positive())),
  turnId: z.optional(z.string().check(z.minLength(1))),
  undoes: z.optional(z.enum(['discard', 'restore'])),
}));
export type FileReviewNoteV1 = z.infer<typeof FileReviewNoteV1Schema>;

/** A content-free, non-ignorable admission operand, stamped into the receipt. */
export const NextTurnFileReviewNoteV1Schema = lazyZodSchema(() => z.literal(FILE_REVIEW_NOTE_KIND));

export function readFileReviewNoteV1(meta: unknown): FileReviewNoteV1 | null {
  if (!meta || typeof meta !== 'object' || !('happier' in meta)) return null;
  const envelope = meta.happier;
  if (!envelope || typeof envelope !== 'object' || !('kind' in envelope)
    || envelope.kind !== FILE_REVIEW_NOTE_KIND || !('payload' in envelope)) return null;
  const parsed = FileReviewNoteV1Schema.safeParse(envelope.payload);
  return parsed.success ? parsed.data : null;
}

/** Agent-facing facts; rendering/localization is owned by the transcript surface. */
export function formatFileReviewNoteV1(note: FileReviewNoteV1): string {
  const paths = note.paths.map(path => JSON.stringify(path)).join(', ');
  const turn = note.turnId ? ` (turn ${JSON.stringify(note.turnId)})` : '';
  if (note.action === 'undo') {
    return `You undid ${note.undoes ? `the ${note.undoes}` : 'the file review action'} in ${paths}${turn}.`;
  }
  if (note.action === 'restore') return `You restored ${paths} to its before state${turn}.`;
  const count = note.changeCount;
  return `You discarded ${count === undefined ? 'changes' : `${count} ${count === 1 ? 'change' : 'changes'}`} in ${paths}${turn}.`;
}
