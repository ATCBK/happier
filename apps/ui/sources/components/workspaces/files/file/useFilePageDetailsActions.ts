import * as React from 'react';
import { useImageWellBackground } from '@/components/ui/media/ImageWell';
import type { WorkspaceFileDetailsFileContent } from '../details/workspaceFileDetails/refreshWorkspaceFileDetails';
import { countFileTextLines } from './filePageModel';

export type FilePageDetailsModel = ReturnType<typeof useFilePageDetailsActions>;

/** Info and Background keep their state here; the page composition places their surfaces. */
export function useFilePageDetailsActions(input: Readonly<{
    path: string;
    kind: string;
    language: string | null;
    content?: WorkspaceFileDetailsFileContent | null;
    sizeBytes?: number | null;
}>) {
    const [open, setOpen] = React.useState<'info' | 'background' | null>(null);
    const [background, setBackground] = useImageWellBackground(input.kind === 'svg' ? 'svg' : 'image');
    const lineCount = React.useMemo(() => input.content && !input.content.isBinary
        ? countFileTextLines(input.content.content) : null, [input.content]);
    React.useEffect(() => setOpen(null), [input.path]);
    return {
        info: { open: open === 'info', path: input.path, kind: input.kind, language: input.language,
            sizeBytes: input.sizeBytes ?? input.content?.binarySizeBytes ?? null,
            encoding: input.content?.encoding ?? null,
            lineCount,
            onClose: () => setOpen(null) },
        background: { open: open === 'background', value: background, onSelect: setBackground, onClose: () => setOpen(null) },
        showInfo: () => setOpen('info'),
        chooseBackground: input.kind === 'image' || input.kind === 'svg' ? () => setOpen('background') : undefined,
    };
}
