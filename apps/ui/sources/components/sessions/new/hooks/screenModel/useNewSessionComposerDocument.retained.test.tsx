import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { RetainedPanelSurface } from '@/components/ui/panels/RetainedPanelSurface';
import { createNewSessionPromptStore } from './newSessionPromptStore';
import { useNewSessionComposerDocument } from './useNewSessionComposerDocument';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(() => standardCleanup());

it('retains the same editable draft lifetime while hidden but rejects callbacks after unmount', async () => {
    const promptStore = createNewSessionPromptStore('Unsent retained draft');
    const holder: { current: ReturnType<typeof useNewSessionComposerDocument> | null } = { current: null };
    function DocumentProbe() {
        holder.current = useNewSessionComposerDocument({
            promptStore, persistedAttachments: [], composerAttachmentEntriesById: {},
            scopeKey: null, canSubmitRef: { current: true }, isSubmitting: false,
        });
        return null;
    }
    const frame = (active: boolean) => <RetainedPanelSurface isActive={active} suspendWhenHidden><DocumentProbe /></RetainedPanelSurface>;
    const screen = await renderScreen(frame(true));
    const document = holder.current!;
    const ref = document.ref;
    expect(document.isCurrent()).toBe(true);
    await screen.update(frame(false));
    expect(document.isCurrent()).toBe(true);
    expect(document.readCurrentDocumentSnapshot()?.text).toBe('Unsent retained draft');
    await screen.update(frame(true));
    expect(holder.current?.ref).toEqual(ref);
    expect(holder.current?.readCurrentDocumentSnapshot()?.text).toBe('Unsent retained draft');
    await screen.unmount();
    expect(document.isCurrent()).toBe(false);
    expect(document.readCurrentDocumentSnapshot()).toBeNull();
    expect(document.captureSubmissionSnapshot()).toBeNull();
});
