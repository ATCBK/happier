import { createTwoFilesPatch } from 'diff';
import type { WorkspaceFileEditSetFile } from '@happier-dev/protocol/machines/workspaceFiles';
import { applyWorkspaceFileTextEdits } from '@happier-dev/protocol/machines/workspaceFilesReplace';

/**
 * One reviewed file of a semantic edit set (rename, file rename, code fix) as the shared review
 * renderer shows it: a unified patch of what the Machine's guarded writer will write, built with the
 * writer's own text transform. Null when the text on hand does not take the edits (it moved on since
 * the preview, or is not the text the server read); the writer's hash guard still decides the apply.
 */
export function buildEditSetPreviewDiff(
  file: WorkspaceFileEditSetFile,
  text: string,
): string | null {
  try {
    const next = applyWorkspaceFileTextEdits(text, file.edits).text;
    const to = file.renameTo ?? file.path;
    return createTwoFilesPatch(file.path, to, text, next, '', '', {
      context: 2,
    });
  } catch {
    return null;
  }
}

/** "4 changes in 2 files": every text edit counts once, a move counts as one change. */
export function countEditSetChanges(
  files: readonly WorkspaceFileEditSetFile[],
): Readonly<{ changes: number; files: number }> {
  let changes = 0;
  for (const file of files)
    changes += file.edits.length + (file.renameTo ? 1 : 0);
  return { changes, files: files.length };
}
