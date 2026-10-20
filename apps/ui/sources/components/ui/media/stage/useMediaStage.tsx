import * as React from 'react';

import {
    KeyboardShortcutContextBridge,
    useKeyboardShortcutContextSnapshot,
    type KeyboardShortcutContextSnapshot,
} from '@/keyboard/KeyboardShortcutProvider';
import { Modal, type CustomModalInjectedProps } from '@/modal';

import { MediaStage } from './MediaStage';
import { freezeMediaStageGallery, type MediaStageItem, type MediaStageProps } from './mediaStageItems';

type MediaStageModalProps = MediaStageProps & CustomModalInjectedProps & Readonly<{
    keyboardContext?: KeyboardShortcutContextSnapshot;
}>;

function MediaStageModal({ keyboardContext, ...props }: MediaStageModalProps) {
    const stage = <MediaStage {...props} />;
    return keyboardContext
        ? <KeyboardShortcutContextBridge snapshot={keyboardContext}>{stage}</KeyboardShortcutContextBridge>
        : stage;
}

/** All callers share the modal owner's focus, portal and dismissal lifecycle. */
export function openMediaStage(
    items: readonly MediaStageItem[],
    index = 0,
    keyboardContext?: KeyboardShortcutContextSnapshot,
): string {
    const gallery = freezeMediaStageGallery(items, index);
    const selected = gallery.items[gallery.initialIndex]!;
    return Modal.show({
        component: MediaStageModal,
        props: { ...gallery, ...(keyboardContext ? { keyboardContext } : {}) },
        chrome: { kind: 'stage', title: selected.title },
        focusReturnRef: selected.originRef,
    });
}

export type MediaStageOpener = Readonly<{
    open: (items: readonly MediaStageItem[], index?: number) => string;
}>;

/** A modal host may sit above this caller's keyboard provider; replay its existing runtime. */
export function useMediaStage(): MediaStageOpener {
    const keyboardContext = useKeyboardShortcutContextSnapshot();
    const open = React.useCallback((items: readonly MediaStageItem[], index = 0) => (
        openMediaStage(items, index, keyboardContext)
    ), [keyboardContext]);
    return React.useMemo(() => ({ open }), [open]);
}
