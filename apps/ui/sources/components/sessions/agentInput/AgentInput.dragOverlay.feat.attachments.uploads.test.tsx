/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle } from '@/dev/testkit';
// Collect the real owner graph before the interaction timeout starts.
import { AgentInput } from './AgentInput';
import { projectAgentInputAttachmentRowItems } from './agentInputContracts';
import { useAttachmentDraftManager } from '@/components/sessions/attachments/useAttachmentDraftManager';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import type { MultiTextInputHandle } from '@/components/ui/forms/MultiTextInput';
import type { ComposerStructuredInputMention } from './structuredInputMentions';
import { scanInlineReferenceTokensV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no browser hit-test API. A point outside the editor falls back to its caret.
Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => null });
afterAll(() => { Reflect.deleteProperty(document, 'elementFromPoint'); });

type HostProps = Readonly<{
    children?: React.ReactNode;
    style?: unknown;
    testID?: string;
    accessibilityLabel?: string;
    onPress?: unknown;
}>;

/** The React Native browser host is the boundary, not the composer or its policies. */
function domHost(tag: 'div' | 'span' | 'button') {
    return React.forwardRef<HTMLElement, HostProps>(function BrowserHost(props, ref) {
        const htmlProps: Record<string, unknown> = {
            ref,
            style: flattenTestStyle(props.style),
            'data-testid': props.testID,
            'aria-label': props.accessibilityLabel,
            onClick: props.onPress,
        };
        for (const [key, value] of Object.entries(props)) {
            if (key.startsWith('data-') || key.startsWith('aria-')) htmlProps[key] = value;
        }
        if (tag === 'button') htmlProps.type = 'button';
        return React.createElement(tag, htmlProps, props.children);
    });
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const View = domHost('div');
    return createReactNativeWebMock({
        View,
        ScrollView: View,
        Text: domHost('span'),
        Pressable: domHost('button'),
        useWindowDimensions: () => ({ width: 800, height: 600 }),
        Dimensions: { get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }) },
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    const { View, Text, ScrollView } = await import('react-native');
    const mock = createReanimatedModuleMock();
    return { ...mock, default: { ...mock.default, View, Text, ScrollView } };
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    const Icon = domHost('span');
    return Object.fromEntries(Object.keys(createExpoVectorIconsMock()).map(name => [name, Icon]));
});

vi.mock('expo-linear-gradient', async () => ({ LinearGradient: (await import('react-native')).View }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), canGoBack: () => false }) }));

// Vitest's default suffix resolution is native; retain the actual browser implementations.
vi.mock('@/components/ui/forms/MultiTextInput', async () => await import('@/components/ui/forms/MultiTextInput.web'));
vi.mock('@/hooks/ui/useWebFileDropZone', async () => await import('@/hooks/ui/useWebFileDropZone.web'));
vi.mock('@/utils/files/webDroppedEntries', async () => await import('@/utils/files/webDroppedEntries.web'));
vi.unmock('color');
vi.unmock('@/components/ui/icons/Icon');

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLElement }> = [];

function UploadComposerHarness({ inputRef, onDrafts }: Readonly<{
    inputRef: React.RefObject<MultiTextInputHandle | null>;
    onDrafts?: (drafts: readonly AttachmentDraft[]) => void;
}>) {
    const [value, setValue] = React.useState('Before after');
    const [mentions, setMentions] = React.useState<readonly ComposerStructuredInputMention[]>([]);
    const attachments = useAttachmentDraftManager({ enabled: true, maxFileBytes: 1024,
        initialDrafts: [{ id: 'first-image', status: 'pending', source: { kind: 'memory', name: 'first.png',
            bytes: new Uint8Array([1]), mimeType: 'image/png', previewUri: 'blob:first-image' } }] });
    React.useEffect(() => { onDrafts?.(attachments.drafts); }, [attachments.drafts, onDrafts]);
    return <AgentInput ref={inputRef} value={value} onChangeText={setValue} placeholder="Message" onSend={() => {}}
        autocompleteKinds={[]} autocompleteSuggestions={async () => []}
        structuredInputMentions={mentions} onStructuredInputMentionsChange={setMentions}
        onAttachmentsAdded={attachments.addWebFiles} hasSendableAttachments={attachments.hasSendableAttachments}
        attachmentRowItems={projectAgentInputAttachmentRowItems({ transferAttachments: attachments.agentInputAttachments })} />;
}

afterEach(async () => {
    await act(async () => {
        for (const { root } of mounted) root.unmount();
    });
    for (const { container } of mounted) container.remove();
    mounted.length = 0;
});

function createFileDragEvent(type: string, files: readonly File[] = [], point = { x: 0, y: 0 }): Event {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: point.x, clientY: point.y });
    Object.defineProperty(event, 'dataTransfer', {
        value: { files, items: files.map(file => ({ kind: 'file', getAsFile: () => file })), types: ['Files'], getData: () => '' },
    });
    return event;
}

async function renderAgentInput(onAttachmentsAdded: NonNullable<React.ComponentProps<typeof AgentInput>['onAttachmentsAdded']>,
    overrides: Partial<React.ComponentProps<typeof AgentInput>> = {}) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    let props: React.ComponentProps<typeof AgentInput> = { value: '', placeholder: 'placeholder', onChangeText: () => {},
        onSend: () => {}, autocompleteKinds: [], autocompleteSuggestions: async () => [],
        onAttachmentsAdded, hasSendableAttachments: false, ...overrides };
    const update = async (next: Partial<React.ComponentProps<typeof AgentInput>>) => {
        props = { ...props, ...next };
        await act(async () => { root.render(<AgentInput {...props} />); });
    };
    await act(async () => {
        root.render(<AgentInput {...props} />);
    });
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="new-session-composer-input"]');
    const material = container.querySelector<HTMLElement>('[data-testid="agent-input-material-surface"]');
    if (!input || !material?.parentElement) throw new Error('Composer input and material surface must render');
    // The enclosing drop host includes the panel rim, outside the textarea and material children.
    return { container, dropSurface: material.parentElement, update };
}

describe('AgentInput (attachments drag overlay)', () => {
    it('pastes an OS image into the real tray and inserts its numbered chip at the caret', async () => {
        const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
        const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
        // Blob URL creation is a browser capability absent from jsdom; intake and numbering stay real.
        Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:pasted-image' });
        Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
        try {
            const container = document.createElement('div');
            document.body.appendChild(container);
            const root = createRoot(container);
            mounted.push({ root, container });
            const inputRef = React.createRef<MultiTextInputHandle>();
            let drafts: readonly AttachmentDraft[] = [];
            const onDrafts = (next: readonly AttachmentDraft[]) => { drafts = next; };
            await act(async () => { root.render(<UploadComposerHarness inputRef={inputRef} onDrafts={onDrafts} />); });
            await act(async () => { inputRef.current?.setTextAndSelection('Before after', { start: 7, end: 7 }); });
            const image = new File(['image'], 'pasted.png', { type: 'image/png' });
            const event = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'clipboardData', { value: { files: [image], types: ['Files'],
                items: [{ kind: 'file', type: 'image/png', getAsFile: () => image }], getData: () => '' } });
            const input = container.querySelector('[data-testid="new-session-composer-input"]')!;
            await act(async () => { input.dispatchEvent(event); });
            const text = inputRef.current?.getText() ?? '';
            const tokens = scanInlineReferenceTokensV1(text);
            expect(drafts).toHaveLength(2);
            expect(drafts[1]?.source).toEqual({ kind: 'web', file: image });
            expect(tokens).toHaveLength(1);
            expect(tokens[0]).toMatchObject({ start: 7, label: 'pasted.png' });
            expect(text.slice(tokens[0]!.end)).toBe(' after');
            expect(container.querySelector('[data-happier-ref-label]')?.textContent).toBe('Image #2');
        } finally {
            if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate);
            else Reflect.deleteProperty(URL, 'createObjectURL');
            if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke);
            else Reflect.deleteProperty(URL, 'revokeObjectURL');
        }
    });

    it('shows Attach beside the pointer and retires it on Escape without changing the draft', async () => {
        const rendered = await renderAgentInput(() => {});
        await act(async () => { rendered.dropSurface.dispatchEvent(createFileDragEvent('dragenter', [], { x: 96, y: 128 })); });
        const overlay = document.querySelector<HTMLElement>('[data-testid="agent-input-drop-overlay"]');
        expect(overlay).not.toBeNull();
        expect(getComputedStyle(overlay!).position).toBe('fixed');
        expect(parseFloat(getComputedStyle(overlay!).left)).toBeGreaterThan(96);
        expect(parseFloat(getComputedStyle(overlay!).top)).toBeGreaterThan(128);
        await act(async () => { rendered.dropSurface.dispatchEvent(createFileDragEvent('dragover', [], { x: 240, y: 320 })); });
        expect(parseFloat(getComputedStyle(overlay!).left)).toBeGreaterThan(240);
        expect(parseFloat(getComputedStyle(overlay!).top)).toBeGreaterThan(320);
        await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
        expect(document.querySelector('[data-testid="agent-input-drop-overlay"]')).toBeNull();
        expect(rendered.container.querySelector<HTMLElement>('[data-testid="new-session-composer-input"]')?.textContent).toBe('');
    });

    it('projects the launch attachment constraint into the existing OS-drop preview', async () => {
        const attachmentDropHint = 'Folders cannot be attached to this launch. Attach files instead.';
        const rendered = await renderAgentInput(() => {}, { attachmentDropHint });
        await act(async () => { rendered.dropSurface.dispatchEvent(createFileDragEvent('dragenter')); });
        const overlay = document.querySelector<HTMLElement>('[data-testid="agent-input-drop-overlay"]');
        expect(overlay?.textContent).toContain(attachmentDropHint);
    });

    it('adds attachments dropped on the enclosing panel outside the textarea', async () => {
        const onAttachmentsAdded = vi.fn();
        const rendered = await renderAgentInput(onAttachmentsAdded);
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
        await act(async () => {
            rendered.dropSurface.dispatchEvent(createFileDragEvent('dragenter', [file]));
            rendered.dropSurface.dispatchEvent(createFileDragEvent('dragover', [file]));
            rendered.dropSurface.dispatchEvent(createFileDragEvent('drop', [file]));
        });
        expect(onAttachmentsAdded).toHaveBeenCalledWith([file]);
    });

    it('uses DataTransfer item files when the dropped FileList is empty', async () => {
        const onAttachmentsAdded = vi.fn();
        const rendered = await renderAgentInput(onAttachmentsAdded);
        const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
        const event = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', {
            value: { files: [], items: [{ kind: 'file', getAsFile: () => file }], types: ['Files'] },
        });
        await act(async () => { rendered.dropSurface.dispatchEvent(event); });
        expect(onAttachmentsAdded).toHaveBeenCalledWith([file]);
    });

    it('binds each dropped upload receipt at the composer caret', async () => {
        const file = new File(['image'], 'photo.png', { type: 'image/png' });
        const onChangeText = vi.fn();
        const onAttachmentsAdded = vi.fn(() => [{ id: 'photo-draft', source: { kind: 'web' as const, file }, status: 'pending' as const }]);
        const rendered = await renderAgentInput(onAttachmentsAdded, { onChangeText });
        await act(async () => { rendered.dropSurface.dispatchEvent(createFileDragEvent('drop', [file])); });
        expect(onAttachmentsAdded).toHaveBeenCalledOnce();
        expect(onChangeText.mock.calls.at(-1)?.[0].trim()).toBe('[photo.png](happier-ref:attachment:photo-draft)');
    });

    it('mentions multiple upload receipts in their intake order without replacing the previous receipt', async () => {
        const files = ['first.txt', 'second.txt'].map(name => new File(['data'], name, { type: 'text/plain' }));
        const onChangeText = vi.fn();
        const rendered = await renderAgentInput(() => files.map((file, index) => ({ id: `draft-${index}`,
            source: { kind: 'web' as const, file }, status: 'pending' as const })), { onChangeText });
        await act(async () => { rendered.dropSurface.dispatchEvent(createFileDragEvent('drop', files)); });
        expect(onChangeText.mock.calls.at(-1)?.[0].trim()).toBe(
            '[first.txt](happier-ref:attachment:draft-0) [second.txt](happier-ref:attachment:draft-1)');
    });

    it('keeps an empty OS folder as one folder receipt and one mention', async () => {
        const onChangeText = vi.fn();
        const onAttachmentsAdded = vi.fn(() => [{ id: 'folder-draft', status: 'pending' as const,
            source: { kind: 'folder' as const, name: 'Design', mimeType: 'inode/directory' as const, entries: [] } }]);
        const rendered = await renderAgentInput(onAttachmentsAdded, { onChangeText });
        const event = new MouseEvent('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'dataTransfer', { value: { files: [], types: ['Files'], items: [{ kind: 'file',
            webkitGetAsEntry: () => ({ isFile: false, isDirectory: true, name: 'Design',
                createReader: () => ({ readEntries: (callback: (entries: unknown[]) => void) => callback([]) }) }),
        }] } });
        await act(async () => { rendered.dropSurface.dispatchEvent(event); });
        expect(onAttachmentsAdded).toHaveBeenCalledWith([], { sources: [{ kind: 'folder', name: 'Design',
            mimeType: 'inode/directory', entries: [], directories: [] }] });
        expect(onChangeText.mock.calls.at(-1)?.[0].trim()).toBe('[Design](happier-ref:attachment:folder-draft)');
    });

    it('attaches a drop on the tray exactly once without adding a text mention', async () => {
        const file = new File(['data'], 'notes.txt', { type: 'text/plain' });
        const onChangeText = vi.fn();
        const onAttachmentsAdded = vi.fn(() => [{ id: 'notes', source: { kind: 'web' as const, file }, status: 'pending' as const }]);
        const rendered = await renderAgentInput(onAttachmentsAdded, { onChangeText,
            attachmentRowItems: [{ kind: 'badge', key: 'existing', attachmentId: 'existing', label: 'Existing file' }] });
        const tray = rendered.container.querySelector<HTMLElement>('[data-testid="agent-input-attachment-drop-target"]')!;
        expect(tray).not.toBeNull();
        await act(async () => { tray.dispatchEvent(createFileDragEvent('drop', [file])); });
        expect(onAttachmentsAdded).toHaveBeenCalledOnce();
        expect(onChangeText).not.toHaveBeenCalled();
    });

    it('keeps the folder chip pending until its upload checkpoint and marks a failed folder removed', async () => {
        const token = '[Design](happier-ref:attachment:folder-draft)';
        const rows = (status: 'pending' | 'uploaded' | 'error') => projectAgentInputAttachmentRowItems({
            transferAttachments: [{ key: 'folder-draft', label: 'Design', attachmentType: 'folder', status }],
        });
        const rendered = await renderAgentInput(() => {}, { value: token,
            structuredInputMentions: [{ kind: 'happier.attachment', ref: 'attachment:folder-draft', label: 'Design',
                tokenText: token, start: 0, end: token.length }], attachmentRowItems: rows('pending') });
        const chipState = () => rendered.container.querySelector('[data-composer-chip-view]')?.getAttribute('data-state');
        expect(chipState()).toBe('pending');
        await rendered.update({ attachmentRowItems: rows('uploaded') });
        expect(chipState()).toBe('ready');
        await rendered.update({ attachmentRowItems: rows('error') });
        expect(chipState()).toBe('removed');
    });
});
