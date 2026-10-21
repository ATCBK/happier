import type { ComposerEditorDecoration } from './composerEditor/composerEditorTypes';
import type { NativeSyntheticEvent, ViewProps } from 'react-native';
import type { CaretRect } from '@/hooks/ui/textInputCaretRect/useTextInputCaretRect.types';
import type { KeyboardKeyPressEventInput } from '@/keyboard/events';
import type { AttachmentUploadSource } from '@/sync/domains/attachments/attachmentsUploadFileSource';

export type NativeComposerAttachmentDrop = Readonly<{
    sources: readonly AttachmentUploadSource[];
    offset: number;
    error?: boolean;
}>;

export type ComposerInputReference = Readonly<{
    token: string;
    start: number;
    end: number;
    ref: string;
    label: string;
    kind: string;
    state?: 'ready' | 'pending' | 'unavailable' | 'removed';
    glyph?: string;
    marker?: string;
    accessibilityLabel?: string;
}>;

export type ComposerInputDecoration = ComposerEditorDecoration;

type Selection = Readonly<{ start: number; end: number }>;
type NativeInputGeometry = Readonly<{ nativeInputTag?: number; caretRect?: CaretRect | null }>;
type NativeBoundReference = Readonly<{ ref: string; token: string; start: number; end: number }>;

export type NativeComposerInputHandle = Readonly<{
    focus: () => void;
    blur: () => void;
    setTextAndSelection: (text: string, selection: Selection, references: readonly ComposerInputReference[]) => void;
    setSelection: (selection: Selection) => void;
    offsetAtPoint: (x: number, y: number) => Promise<number | null>;
    setDropCaret: (offset: number | null) => void;
    measureInWindow: (callback: (x: number, y: number, width: number, height: number) => void) => void;
}>;

export type NativeComposerInputProps = Omit<ViewProps, 'onFocus' | 'onBlur'> & Readonly<{
    value: string;
    mostRecentEventCount: number;
    references: readonly ComposerInputReference[];
    decorations: readonly ComposerInputDecoration[];
    theme: Readonly<{
        text: string; placeholder: string; chipForeground: string; chipGlyphForeground: string; chipBackground: string;
        selection: string; warning: string; success: string; muted: string; link: string;
    }>;
    typography: Readonly<{
        fontFamily?: string; fontSize: number; lineHeight: number; fontWeight?: string;
        chipFontFamily?: string; monoFontFamily?: string; chipHeight: number; chipRadius: number; chipMaxLabelWidth: number;
        chipPaddingLeft: number; chipPaddingRight: number; chipGlyphSize: number; chipGap: number;
    }>;
    padding: Readonly<{ top: number; bottom: number; left: number; right: number }>;
    minHeight: number;
    maxHeight: number;
    editable: boolean;
    placeholder: string;
    returnKeyType: 'send' | 'default';
    submitBehavior: 'newline' | 'submit' | 'blurAndSubmit';
    autoFocus: boolean;
    autoCorrect: boolean;
    autoCapitalize: 'sentences';
    initialScrollY?: number;
    scrollRestoreToken?: string;
    referenceMenuLabels: Readonly<{ open: string; remove: string }>;
    acceptsAttachmentDrops: boolean;
    attachmentDropScope: string;
    onAttachmentDrop: (event: NativeSyntheticEvent<NativeComposerAttachmentDrop & Readonly<{ scope: string }>>) => void;
    onChange: (event: NativeSyntheticEvent<NativeInputGeometry & Readonly<{ text: string; selection: Selection; eventCount: number; references: readonly NativeBoundReference[] }>>) => void;
    onSelection: (event: NativeSyntheticEvent<NativeInputGeometry & Readonly<{ selection: Selection }>>) => void;
    onKeyPress: (event: NativeSyntheticEvent<KeyboardKeyPressEventInput & Readonly<{ submitting?: boolean }>>) => void;
    onFocus: (event?: NativeSyntheticEvent<NativeInputGeometry>) => void;
    onBlur?: () => void;
    onSubmitEditing?: (event?: NativeSyntheticEvent<KeyboardKeyPressEventInput>) => void;
    onContentHeightChange: (event: NativeSyntheticEvent<Readonly<{ height: number }>>) => void;
    onScroll: (event: NativeSyntheticEvent<NativeInputGeometry & Readonly<{ y: number }>>) => void;
    onReferencePress?: (event: NativeSyntheticEvent<Readonly<{ ref: string }>>) => void;
    onDecorationPress?: (event: NativeSyntheticEvent<Readonly<{ url: string }>>) => void;
}>;
