import * as React from 'react';

import type { TextEditorHandle } from '@/components/ui/code/editor/codeEditorTypes';
import { ReviewCommentInlineComposer } from '@/components/ui/code/reviewComments/ReviewCommentInlineComposer';
import { askAboutRanges } from '@/components/ui/code/selection/askAboutRanges';
import type { AskSelection } from '@/components/ui/code/selection/useAskSelection';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { t } from '@/text';

/** The editor's one open comment: the lines it hangs from and the page's inline composer. */
export type FileEditorInlineComment = Readonly<{
  startLine: number;
  endLine: number;
  content: React.ReactNode;
  close: () => void;
}>;

/**
 * Comment on an editor selection (lab AS1): the selection toolbar's Comment opens the page's inline
 * composer under the selected lines, inside the editor's own peek room, so the engine keeps its buffer
 * and caret. Save writes through the selection Comment owner, which anchors a dirty buffer to the saved
 * bytes; nothing new is anchored here.
 */
export function useFileEditorInlineComment(
  input: Readonly<{
    enabled: boolean;
    scope: WorkspaceScopeBase | null;
    filePath: string;
    handle: TextEditorHandle | null;
    savedText: string | undefined;
    onError: (message: string) => void;
  }>,
): Readonly<{
  onCommentSelection: ((selection: AskSelection) => void) | undefined;
  comment: FileEditorInlineComment | null;
}> {
  const [open, setOpen] = React.useState<AskSelection | null>(null);
  const [body, setBody] = React.useState('');
  const latest = React.useRef(input);
  latest.current = input;
  const close = React.useCallback(() => {
    setOpen(null);
    setBody('');
  }, []);
  // A different file, or the editor leaving, drops the unsaved composer with it.
  React.useEffect(close, [close, input.filePath, input.handle, input.enabled]);
  const onCommentSelection = React.useCallback((selection: AskSelection) => {
    setOpen(selection);
    setBody('');
  }, []);
  const save = React.useCallback(async () => {
    const params = latest.current;
    const text = body.trim();
    if (!open || !params.scope) return;
    if (!text) {
      params.onError(t('files.reviewComments.errors.empty'));
      return;
    }
    const live = params.handle?.getValue();
    const result = await askAboutRanges({
      workspaceScope: params.scope,
      filePath: params.filePath,
      ranges: [
        {
          startLine: open.startLine,
          endLine: open.endLine,
          text: open.text,
          body: text,
        },
      ],
      savedText: params.savedText ?? live ?? '',
      text: live,
      source: 'file',
      sessionTarget: null,
      includeInPrompt: false,
    });
    if (result.created > 0) close();
    else params.onError(t('files.selectionFailed'));
  }, [body, close, open]);
  const comment = React.useMemo<FileEditorInlineComment | null>(
    () =>
      open
        ? {
            startLine: open.startLine,
            endLine: open.endLine,
            close,
            content: (
              <ReviewCommentInlineComposer
                value={body}
                onChange={setBody}
                onCancel={close}
                onSave={() => {
                  void save();
                }}
                autoFocus
              />
            ),
          }
        : null,
    [body, close, open, save],
  );
  return {
    onCommentSelection:
      input.enabled && input.scope ? onCommentSelection : undefined,
    comment,
  };
}
