import type { ReactNode } from 'react';

/** Presentation of an already-bound reference. Text alone never grants chip identity. */
export type ComposerEditorReference<TBinding = unknown> = Readonly<{
    ref: string;
    token: string;
    start: number;
    end: number;
    kind: string;
    label: string;
    state?: 'ready' | 'pending' | 'removed' | 'unavailable';
    accessibilityLabel?: string;
    readableMarker?: string;
    thumbnail?: ReactNode;
    onOpen?: () => void;
    /** Opaque owner binding retained by undo; the editor never interprets it. */
    binding?: TBinding;
}>;

export type ComposerEditorDecoration = Readonly<{
    start: number;
    end: number;
    treatment: 'highlight' | 'muted' | 'warning' | 'success' | 'code' | Readonly<{ kind: 'link'; url: string }>;
    label?: string;
}>;

export type ComposerEditorSelection = Readonly<{ start: number; end: number }>;
export type ComposerEditorCaretRect = Readonly<{ left: number; top: number; height: number }>;
