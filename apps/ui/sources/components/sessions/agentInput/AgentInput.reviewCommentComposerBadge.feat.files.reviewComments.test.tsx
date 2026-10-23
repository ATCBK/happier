import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

import type { ReviewCommentDraft } from '@/sync/domains/input/reviewComments/reviewCommentTypes';
import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';

import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((result, entry) => ({ ...result, ...flattenStyle(entry) }), {});
    }
    return typeof style === 'object' ? style as Record<string, unknown> : {};
}

const modalAlertSpy = vi.fn();
const modalShowSpy = vi.fn((_config: unknown) => 'review-comments-modal');
const setDraftIncludedSpy = vi.fn();
const clearDraftsSpy = vi.fn();
const deleteDraftSpy = vi.fn();
const updateDraftSpy = vi.fn();

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            TurboModuleRegistry: {
                get: () => ({}),
                getEnforcing: () => ({}),
            },
            Platform: {
                OS: 'web',
                select: (x: any) => x?.web ?? x?.default ?? x?.ios ?? x?.android ?? null,
            },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                show: (config: unknown) => modalShowSpy(config) as any,
                alert: (...args: unknown[]) => modalAlertSpy(...args),
                confirm: vi.fn(),
                prompt: vi.fn(),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'profiles') return [];
                if (key === 'agentInputEnterToSend') return true;
                if (key === 'agentInputActionBarLayout') return 'wrap';
                if (key === 'agentInputChipDensity') return 'labels';
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                return null;
            },
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => {
        const store = (selector: any) => selector({ sessionMessages: {} });
        store.getState = () => ({
            localSettings: {
                uiContentWidthMode: 'wide',
            },
            sessionMessages: {},
        });
        return store;
    },
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/store/hooks')>();
    return {
        ...actual,
        useLocalSetting: () => 1,
    };
});

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: () => null,
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    isBundledAgentId: (value: unknown) => typeof value === 'string' && ['codex', 'claude', 'opencode', 'gemini'].includes(value),
    resolveAgentIdFromFlavor: () => null,
    resolveAgentIdFromFlavorNoDefault: () => null,
    getAgentCore: () => ({
        displayNameKey: 'agents.codex',
        toolRendering: { hideUnknownToolsByDefault: false },
        model: { supportsSelection: false, allowedModes: [] },
        permissions: { modeGroup: 'codexLike' },
        sessionModes: { kind: 'legacy' },
    }),
    getAgentBehavior: () => ({
        sessionUsage: {
            supportsExactContextUsageBadge: false,
        },
    }),
}));

describe('AgentInput review comment composer badge', () => {
    let AgentInput: typeof import('./AgentInput')['AgentInput'];
    let createReviewCommentsActionChip: typeof import('./definitions/createReviewCommentsActionChip')['createReviewCommentsActionChip'];
    // The composer's module graph loads once, after the module mocks above, in its own hook budget: a cold
    // load must not eat the first case's budget and leave that case rendering on into the next one.
    beforeAll(async () => {
        ({ AgentInput } = await import('./AgentInput'));
        ({ createReviewCommentsActionChip } = await import('./definitions/createReviewCommentsActionChip'));
    });

    it('renders review drafts as an attachment-style badge that opens the review action', async () => {

        const draft = {
            id: 'draft-1',
            filePath: 'src/demo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12 },
            snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
            body: 'Consider extracting this.',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        const reviewCommentsPresentation = createReviewCommentsActionChip({
            reviewScope: {
                serverId: 'server-1',
                machineId: 'machine-1',
                rootPath: '/repo',
            } satisfies WorkspaceScopeBase,
            reviewCommentDrafts: [draft],
            onSetDraftIncluded: setDraftIncludedSpy,
            onClearDrafts: clearDraftsSpy,
            onDeleteDraft: deleteDraftSpy,
            onUpdateDraft: updateDraftSpy,
        });
        if (!reviewCommentsPresentation) {
            throw new Error('Expected review comments chip');
        }

        const { actionChip: reviewCommentsChip, attachmentRowItem: reviewCommentsRowItem } = reviewCommentsPresentation;

        expect('composerAttachmentBadge' in reviewCommentsChip).toBe(false);
        expect(reviewCommentsRowItem).toMatchObject({
            kind: 'badge',
            testID: 'agent-input-review-comments-attachment-badge',
        });

        modalAlertSpy.mockClear();
        modalShowSpy.mockClear();

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="placeholder"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[reviewCommentsChip]}
                attachmentRowItems={reviewCommentsRowItem ? [reviewCommentsRowItem] : []}
            />,
        );

        expect(screen.findByTestId('agent-input-review-comments-attachment-badge')).toBeTruthy();

        await screen.pressByTestIdAsync('agent-input-review-comments-attachment-badge-preview');

        expect(modalShowSpy).toHaveBeenCalledTimes(1);
        const modalConfig = modalShowSpy.mock.calls[0]?.[0] as any;
        expect(modalConfig?.component?.name).toBe('ReviewCommentsDraftsModal');
        expect(modalConfig?.props?.reviewScope).toEqual({
            serverId: 'server-1',
            machineId: 'machine-1',
            rootPath: '/repo',
        });
        expect(modalConfig?.chrome?.kind).toBe('card');
    });

    it('names the file and its lines when one selection rides with the message, and counts several', async () => {

        const rangeDraft = {
            id: 'draft-range',
            filePath: 'apps/ui/settings/SettingsModal.tsx',
            source: 'diff',
            anchor: { kind: 'range', filePath: 'apps/ui/settings/SettingsModal.tsx', startLine: 19, endLine: 24, side: 'after' },
            snapshot: { selectedLines: ['export function SettingsModal() {'], beforeContext: [], afterContext: [] },
            body: '',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        const lineDraft = {
            id: 'draft-line',
            filePath: 'src/retry.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 8 },
            snapshot: { selectedLines: ['function delayFor() {'], beforeContext: [], afterContext: [] },
            body: '',
            createdAt: 2,
        } satisfies ReviewCommentDraft;
        const render = async (drafts: readonly ReviewCommentDraft[]) => {
            const presentation = createReviewCommentsActionChip({
                reviewCommentDrafts: drafts,
                onSetDraftIncluded: setDraftIncludedSpy,
                onClearDrafts: clearDraftsSpy,
                onDeleteDraft: deleteDraftSpy,
                onUpdateDraft: updateDraftSpy,
            });
            if (!presentation) throw new Error('Expected review comments chip');
            return renderScreen(
                <AgentInput
                    value=""
                    placeholder="placeholder"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    attachmentRowItems={presentation.attachmentRowItem ? [presentation.attachmentRowItem] : []}
                />,
            );
        };

        const one = await render([rangeDraft]);
        const oneBadge = one.findByTestId('agent-input-review-comments-attachment-badge-preview');
        expect(oneBadge?.props.accessibilityLabel).toBe('SettingsModal.tsx 19–24');
        expect(one.getTextContent()).toContain('SettingsModal.tsx');
        expect(one.getTextContent()).toContain('19–24');
        expect(one.getTextContent()).not.toContain('files.reviewComments.draftsChipLabel');

        const single = await render([lineDraft]);
        expect(single.findByTestId('agent-input-review-comments-attachment-badge-preview')?.props.accessibilityLabel).toBe('retry.ts 8');

        // A detached selection does not ride with the message, so the chip names the one that does.
        const detachedAndOne = await render([{ ...lineDraft, includeInPrompt: false }, rangeDraft]);
        expect(detachedAndOne.findByTestId('agent-input-review-comments-attachment-badge-preview')?.props.accessibilityLabel).toBe('SettingsModal.tsx 19–24');

        const several = await render([rangeDraft, lineDraft]);
        expect(several.findByTestId('agent-input-review-comments-attachment-badge-preview')?.props.accessibilityLabel).toBe('files.reviewComments.draftsChipLabel');
    });

    it('lets the user detach or discard review comments from the composer badge remove button', async () => {

        const draft = {
            id: 'draft-1',
            filePath: 'src/demo.ts',
            source: 'file',
            anchor: { kind: 'fileLine', startLine: 12 },
            snapshot: { selectedLines: ['const x = 1;'], beforeContext: [], afterContext: [] },
            body: 'Consider extracting this.',
            createdAt: 1,
        } satisfies ReviewCommentDraft;
        const reviewCommentsPresentation = createReviewCommentsActionChip({
            reviewCommentDrafts: [draft],
            onSetDraftIncluded: setDraftIncludedSpy,
            onClearDrafts: clearDraftsSpy,
            onDeleteDraft: deleteDraftSpy,
            onUpdateDraft: updateDraftSpy,
        });
        if (!reviewCommentsPresentation) {
            throw new Error('Expected review comments chip');
        }

        const { actionChip: reviewCommentsChip, attachmentRowItem: reviewCommentsRowItem } = reviewCommentsPresentation;

        expect('composerAttachmentBadge' in reviewCommentsChip).toBe(false);

        modalAlertSpy.mockClear();
        setDraftIncludedSpy.mockClear();
        clearDraftsSpy.mockClear();

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="placeholder"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[reviewCommentsChip]}
                attachmentRowItems={reviewCommentsRowItem ? [reviewCommentsRowItem] : []}
            />,
        );

        const { resolveMinimumInteractiveTargetSize } = await import('@/components/ui/interactiveTargetSize');
        const touchFloor = resolveMinimumInteractiveTargetSize('web');
        const removeButton = screen.findByTestId('agent-input-review-comments-attachment-badge-remove');
        expect(removeButton?.props.accessibilityRole).toBe('button');
        expect(removeButton?.props.accessibilityLabel).toBe('files.reviewComments.detachOrDiscardTitle');
        expect(removeButton?.props.hitSlop).toBeUndefined();
        expect(flattenStyle(removeButton?.props.style)).toMatchObject({ minHeight: touchFloor, minWidth: touchFloor });

        await screen.pressByTestIdAsync('agent-input-review-comments-attachment-badge-remove');

        expect(modalAlertSpy).toHaveBeenCalledTimes(1);
        const buttons = modalAlertSpy.mock.calls[0]?.[2] as any[];
        const detachButton = buttons.find((button) => button.text === 'files.reviewComments.detachFromPrompt');
        const discardButton = buttons.find((button) => button.style === 'destructive');

        detachButton.onPress();
        expect(setDraftIncludedSpy).toHaveBeenCalledWith('draft-1', false);

        discardButton.onPress();
        expect(clearDraftsSpy).toHaveBeenCalled();
    });
});
