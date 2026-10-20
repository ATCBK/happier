import * as React from 'react';
import { useFindSurfaceRegistration } from '@/keyboard/KeyboardShortcutProvider';
import { usePluginSurfaceFocusEligibility } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { createPdfFindModel, type PdfFindDocument, type PdfFindMatch, type PdfFindSurfaceModel } from './pdfFindModel';

export function usePdfFind(input: Readonly<{
    surfaceId: string; document: PdfFindDocument | null; active: boolean;
    controller?: PdfFindSurfaceModel;
    containsFocus(): boolean; isInputFocused(): boolean;
    reveal(match: PdfFindMatch): void; focusInput(): void;
}>) {
    const latest = React.useRef(input); latest.current = input;
    const [model] = React.useState(() => createPdfFindModel({ reveal: match => latest.current.reveal(match) }));
    const controller = input.controller ?? model;
    const snapshot = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const eligible = usePluginSurfaceFocusEligibility();
    React.useEffect(() => { if (!input.controller) model.setDocument(input.document); return () => model.setDocument(null); }, [model, input.controller, input.document]);
    React.useEffect(() => () => controller.close(), [controller]);
    useFindSurfaceRegistration(eligible && input.active && (input.document || input.controller) ? {
        surfaceId: input.surfaceId, containsFocus: () => latest.current.containsFocus(),
        isOpen: () => controller.getSnapshot().open, isInputFocused: () => latest.current.isInputFocused(),
        open: () => { controller.open(); latest.current.focusInput(); }, controller,
    } : null);
    return { snapshot, controller };
}
