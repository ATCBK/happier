import * as React from 'react';
import { useImageWellBackground } from '@/components/ui/media/ImageWell';
import { Modal } from '@/modal';
import type { WorkspaceFileDetailsFileContent } from '../details/workspaceFileDetails/refreshWorkspaceFileDetails';
import { countFileTextLines } from './filePageModel';
import { FilePageInfoDialog } from './FilePageInfoDialog';

export type FilePageDetailsModel = ReturnType<typeof useFilePageDetailsActions>;

/**
 * `⋯ › Info` and `⋯ › Background` (P3 §3.2, P2 U6). Info opens the facts dialog; Background is the per-kind,
 * device-local choice (Checkerboard · Light · Dark) the menu draws as its chooser, for pictures only.
 */
export function useFilePageDetailsActions(
  input: Readonly<{
    path: string;
    kind: string;
    /** What the viewer calls this file ("Text file", "PNG image"), for Info. */
    kindLabel?: string | null;
    language: string | null;
    content?: WorkspaceFileDetailsFileContent | null;
    sizeBytes?: number | null;
  }>,
) {
  const picture = input.kind === 'image' || input.kind === 'svg';
  const [background, setBackground] = useImageWellBackground(
    input.kind === 'svg' ? 'svg' : 'image',
  );
  const lineCount = React.useMemo(
    () =>
      input.content && !input.content.isBinary
        ? countFileTextLines(input.content.content)
        : null,
    [input.content],
  );
  const info = {
    path: input.path,
    kindLabel: input.kindLabel ?? null,
    language: input.language,
    sizeBytes: input.sizeBytes ?? input.content?.binarySizeBytes ?? null,
    encoding: input.content?.encoding ?? null,
    lineCount,
  };
  const infoRef = React.useRef(info);
  infoRef.current = info;
  const contentRef = React.useRef(input.content);
  contentRef.current = input.content;
  const showInfo = React.useCallback(() => {
    Modal.show({
      component: FilePageInfoDialog,
      // A held whole text's size is its encoded bytes, measured only when Info opens.
      props: { facts: { ...infoRef.current, sizeBytes: infoRef.current.sizeBytes ?? heldTextBytes(contentRef.current) } },
    });
  }, []);
  return {
    info,
    background: picture ? { value: background, onSelect: setBackground } : null,
    showInfo,
    /** The menu draws this row as the Background chooser; its choices are the `background` model above. */
    chooseBackground: picture ? noop : undefined,
  };
}

function noop() {}

function heldTextBytes(content: WorkspaceFileDetailsFileContent | null | undefined): number | null {
  if (!content || content.isBinary || content.partial) return null;
  return new TextEncoder().encode(content.content).byteLength;
}
