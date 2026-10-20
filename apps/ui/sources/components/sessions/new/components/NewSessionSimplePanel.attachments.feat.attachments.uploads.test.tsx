import * as React from 'react';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { afterEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installNewSessionComponentsCommonModuleMocks } from './newSessionComponentsTestHelpers';
import type { AttachmentDraft } from '@/components/sessions/attachments/attachmentDraftModel';
import { clearAllNewSessionAttachmentDrafts, readNewSessionAttachmentDrafts, writeNewSessionAttachmentDrafts } from '../attachments/newSessionAttachmentDraftStore';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AgentInputMock = vi.fn((_props: any) => null);
const mockEnv = vi.hoisted(() => ({
    iconsRenderAsText: false,
}));
const uploadAttachmentDraftsToSessionSpy = vi.hoisted(() => vi.fn());
const formatAttachmentsBlockSpy = vi.hoisted(() => vi.fn(() => ''));
const followUpSpawnedSessionWithServerScopeSpy = vi.hoisted(() => vi.fn());
const workspaceReviewDraftsState = vi.hoisted(() => ({
    draftsByRootPath: new Map<string, Array<{
        id: string;
        filePath: string;
        source: 'file' | 'diff';
        anchor: Record<string, unknown>;
        snapshot: {
            selectedLines: string[];
            beforeContext: string[];
            afterContext: string[];
        };
        body: string;
        includeInPrompt?: boolean;
        createdAt: number;
    }>>(),
}));

installNewSessionComponentsCommonModuleMocks({
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => (
            mockEnv.iconsRenderAsText ? <>{'.'}</> : React.createElement('Ionicons', props, null)
        ),
    }),
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Platform: {
                OS: 'web',
                select: (v: any) => v.web ?? v.default ?? null,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useWorkspaceReviewCommentsDrafts: (scope: { rootPath?: string } | null | undefined) => (
                scope?.rootPath ? (workspaceReviewDraftsState.draftsByRootPath.get(scope.rootPath) ?? []) : []
            ),
        });
    },
});

vi.mock('react-native-keyboard-controller', () => ({
    KeyboardAvoidingView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('KeyboardAvoidingView', props, props.children),
    useKeyboardHandler: () => {},
    useReanimatedKeyboardAnimation: () => ({
        height: { value: 0 },
        progress: { value: 0 },
    }),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverBoundaryProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
    PopoverPortalTargetProvider: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
    PopoverScope: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/sessions/agentInput', () => ({
    AgentInput: AgentInputMock,
}));

vi.mock('@/components/sessions/attachments/AttachmentFilePicker', () => ({
    AttachmentFilePicker: () => null,
}));

vi.mock('@/components/sessions/attachments/useAttachmentsUploadConfig', () => ({
    useAttachmentsUploadConfig: () => ({
        uploadLocation: 'workspace',
        workspaceRelativeDir: '.happier/uploads',
        vcsIgnoreStrategy: 'git_info_exclude',
        vcsIgnoreWritesEnabled: true,
        maxFileBytes: 25 * 1024 * 1024,
    }),
}));

vi.mock('@/components/sessions/attachments/uploadAttachmentDraftsToSession', () => ({
    uploadAttachmentDraftsToSession: uploadAttachmentDraftsToSessionSpy,
    formatAttachmentsBlock: formatAttachmentsBlockSpy,
    buildAttachmentMessageMeta: (uploaded: unknown) => ({
        happier: {
            kind: 'attachments.v1',
            payload: {
                attachments: uploaded,
            },
        },
    }),
}));

vi.mock('@/sync/sync', () => ({
    sync: { sendMessage: vi.fn() },
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/followUpSpawnedSession', () => ({
    followUpSpawnedSessionWithServerScope: followUpSpawnedSessionWithServerScopeSpy,
}));

vi.mock('@/utils/platform/deferOnWeb', () => ({
    blurActiveElementOnWeb: vi.fn(),
    deferOnWeb: (callback: () => void) => callback(),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'attachments.uploads' || featureId === 'files.reviewComments',
}));

afterEach(() => {
    workspaceReviewDraftsState.draftsByRootPath.clear();
    standardCleanup();
    clearAllNewSessionAttachmentDrafts();
});

describe('NewSessionSimplePanel (attachments.uploads)', () => {
    it('wires AgentInput attachments handlers and attach action when enabled', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();

        await renderScreen(React.createElement(NewSessionSimplePanel, {
                    popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                    headerHeight: 44,
                    safeAreaTop: 0,
                    safeAreaBottom: 0,
                    newSessionTopPadding: 0,
                    newSessionSidePadding: 0,
                    newSessionBottomPadding: 0,
                    containerStyle: {},
                    promptStore: createNewSessionPromptStore(''),
                    setSessionPrompt: () => {},
                    handleCreateSession: () => {},
                    canCreate: true,
                    isCreating: false,
                    emptyAutocompleteKinds: [],
                    emptyAutocompleteSuggestions: async () => [],
                    sessionPromptInputMaxHeight: 200,
                    agentInputExtraActionChips: [],
                    agentType: 'codex',
                    handleAgentClick: () => {},
                    permissionMode: 'default',
                    handlePermissionModeChange: () => {},
                    modelMode: 'default',
                    setModelMode: () => {},
                    modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                    connectionStatus: undefined,
                    machineName: undefined,
                    selectedPath: '',
                    showResumePicker: false,
                    resumeSessionId: null,
                    isResumeSupportChecking: false,
                    useProfiles: false,
                    selectedProfileId: null,
                }));

        expect(AgentInputMock).toHaveBeenCalled();
        const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
        const attachmentChip = props.extraActionChips.find((c: any) => c?.key === 'attachments-add');

        expect(typeof props.onAttachmentsAdded).toBe('function');
        expect(Array.isArray(props.extraActionChips)).toBe(true);
        expect(attachmentChip).toMatchObject({
            key: 'attachments-add',
            controlId: 'attachments',
        });
        expect(typeof attachmentChip?.collapsedAction).toBe('function');
    });

    it('projects its semantic Composer document through the attachment-owner and input surface', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');
        const onSelectionChangePersist = vi.fn();
        const onStructuredInputMentionsChange = vi.fn();
        const composerDocument = {
            ref: { kind: 'newSession', instanceId: 'new-session-composer-scope' },
            revision: 1,
            attachments: [{
                v: 1,
                instanceId: 'issue-42',
                attachment: { pluginId: 'acme.issues', localId: 'issue' },
                key: '42',
                value: { issueId: 42 },
                presentation: { label: 'Issue #42', typeLabel: 'Issue' },
            }],
            structuredInputMentions: [],
            onStructuredInputMentionsChange,
            attachmentRowItems: [{
                kind: 'badge',
                key: 'issue-42',
                label: 'Issue #42',
                availability: 'ready',
            }],
            hasSendableAttachments: true,
            captureSubmissionSnapshot: () => null,
            clearAcceptedSnapshot: () => false,
            inputPersistence: { restoreToken: 'new-session-composer-scope', onSelectionChangePersist },
        };

        AgentInputMock.mockClear();
        await renderScreen(React.createElement(NewSessionSimplePanel, {
            popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
            headerHeight: 44,
            safeAreaTop: 0,
            safeAreaBottom: 0,
            newSessionTopPadding: 0,
            newSessionSidePadding: 0,
            newSessionBottomPadding: 0,
            containerStyle: {},
            promptStore: createNewSessionPromptStore(''),
            composerDocument: composerDocument as any,
            setSessionPrompt: () => {},
            handleCreateSession: () => {},
            canCreate: true,
            isCreating: false,
            emptyAutocompleteKinds: [],
            emptyAutocompleteSuggestions: async () => [],
            sessionPromptInputMaxHeight: 200,
            agentInputExtraActionChips: [],
            agentType: 'codex',
            handleAgentClick: () => {},
            permissionMode: 'default',
            handlePermissionModeChange: () => {},
            modelMode: 'default',
            setModelMode: () => {},
            modelOptions: [{ value: 'default', label: 'Default', description: '' }],
            connectionStatus: undefined,
            machineName: undefined,
            selectedPath: '',
            showResumePicker: false,
            resumeSessionId: null,
            isResumeSupportChecking: false,
            useProfiles: false,
            selectedProfileId: null,
        }));

        const inputProps = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
        expect(inputProps.structuredInputMentions).toEqual([]);
        expect(inputProps.onStructuredInputMentionsChange).toBe(onStructuredInputMentionsChange);
        expect(inputProps.hasSendableAttachments).toBe(true);
        // The input reports its caret through the document's own persistence seam,
        // so the Automation handoff reads the caret that is actually on screen.
        inputProps.inputPersistence.onSelectionChangePersist({ start: 2, end: 2 }, 0);
        expect(onSelectionChangePersist).toHaveBeenCalledWith({ start: 2, end: 2 }, 0);
        expect(inputProps.attachmentRowItems).toContainEqual(expect.objectContaining({
            key: 'issue-42',
            label: 'Issue #42',
        }));
    });

    it('does not emit raw text nodes under View when the attachment icon renders as text on web', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        mockEnv.iconsRenderAsText = true;

        let tree: renderer.ReactTestRenderer | undefined;
        try {
            tree = (await renderScreen(React.createElement(NewSessionSimplePanel, {
                        popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                        headerHeight: 44,
                        safeAreaTop: 0,
                        safeAreaBottom: 0,
                        newSessionTopPadding: 0,
                        newSessionSidePadding: 0,
                        newSessionBottomPadding: 0,
                        containerStyle: {},
                        promptStore: createNewSessionPromptStore(''),
                        setSessionPrompt: () => {},
                        handleCreateSession: () => {},
                        canCreate: true,
                        isCreating: false,
                        emptyAutocompleteKinds: [],
                        emptyAutocompleteSuggestions: async () => [],
                        sessionPromptInputMaxHeight: 200,
                        agentInputExtraActionChips: [],
                        agentType: 'codex',
                        handleAgentClick: () => {},
                        permissionMode: 'default',
                        handlePermissionModeChange: () => {},
                        modelMode: 'default',
                        setModelMode: () => {},
                        modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                        connectionStatus: undefined,
                        machineName: undefined,
                        selectedPath: '',
                        showResumePicker: false,
                        resumeSessionId: null,
                        isResumeSupportChecking: false,
                        useProfiles: false,
                        selectedProfileId: null,
                    }))).tree;

            const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
            const attachmentChip = props.extraActionChips.find((chip: any) => chip?.key === 'attachments-add');
            expect(attachmentChip).toBeTruthy();

            tree = (await renderScreen(attachmentChip.render({
                        chipStyle: () => ({}),
                        iconColor: '#000',
                        showLabel: false,
                        textStyle: {},
                    }))).tree;

            const badNodes: Array<{ parent: string | null; value: string }> = [];
            const walk = (node: any, parentType: string | null) => {
                if (node == null) return;
                if (typeof node === 'string') {
                    if (parentType !== 'Text' && node.trim().length > 0) badNodes.push({ parent: parentType, value: node });
                    return;
                }
                if (Array.isArray(node)) {
                    for (const child of node) walk(child, parentType);
                    return;
                }
                const nextParent = typeof node.type === 'string' ? node.type : parentType;
                const children = Array.isArray(node.children) ? node.children : [];
                for (const child of children) walk(child, nextParent);
            };

            if (!tree) throw new Error('Expected attachment panel tree');
            walk(tree.toJSON(), null);
            expect(badNodes).toEqual([]);
        } finally {
            mockEnv.iconsRenderAsText = false;
            await act(async () => {
                tree?.unmount();
            });
        }
    });

    it('routes first attachment follow-up through the server-scoped spawned-session helper', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        const drafts: AttachmentDraft[] = [{ id: 'draft-1', status: 'pending', source: {
            kind: 'memory', bytes: new Uint8Array(12), name: 'notes.txt', mimeType: 'text/plain',
        } }];
        writeNewSessionAttachmentDrafts('panel-follow-up', drafts);
        uploadAttachmentDraftsToSessionSpy.mockReset();
        formatAttachmentsBlockSpy.mockReset();
        followUpSpawnedSessionWithServerScopeSpy.mockReset();

        uploadAttachmentDraftsToSessionSpy.mockResolvedValue({
            uploaded: [{
                name: 'notes.txt',
                path: '.happier/uploads/notes.txt',
                mimeType: 'text/plain',
                sizeBytes: 12,
                sha256: 'abc123',
            }],
        });
        formatAttachmentsBlockSpy.mockReturnValue('[attachments block]');

        const handleCreateSession = vi.fn();

        await renderScreen(React.createElement(NewSessionSimplePanel, {
                    popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
                    headerHeight: 44,
                    safeAreaTop: 0,
                    safeAreaBottom: 0,
                    newSessionTopPadding: 0,
                    newSessionSidePadding: 0,
                    newSessionBottomPadding: 0,
                    containerStyle: {},
                    promptStore: createNewSessionPromptStore('Investigate this bug'),
                    setSessionPrompt: () => {},
                    handleCreateSession,
                    attachmentFlowId: 'panel-follow-up',
                    canCreate: true,
                    isCreating: false,
                    emptyAutocompleteKinds: [],
                    emptyAutocompleteSuggestions: async () => [],
                    sessionPromptInputMaxHeight: 200,
                    agentInputExtraActionChips: [],
                    agentType: 'codex',
                    handleAgentClick: () => {},
                    permissionMode: 'default',
                    handlePermissionModeChange: () => {},
                    modelMode: 'default',
                    setModelMode: () => {},
                    modelOptions: [{ value: 'default', label: 'Default', description: '' }],
                    connectionStatus: undefined,
                    machineName: undefined,
                    selectedPath: '',
                    showResumePicker: false,
                    resumeSessionId: null,
                    isResumeSupportChecking: false,
                    useProfiles: true,
                    selectedProfileId: 'profile-work',
                    targetServerId: 'server-b',
                }));

        const props = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
        await act(async () => {
            props.onSend();
        });

        expect(handleCreateSession).toHaveBeenCalledWith(expect.objectContaining({ initialMessage: 'skip' }));

        const afterCreated = handleCreateSession.mock.calls[0]?.[0]?.afterCreated;
        expect(typeof afterCreated).toBe('function');

        await act(async () => {
            await afterCreated({
                sessionId: 'sess_target',
                effectiveSpawnServerId: 'server-a',
                launchAttempt: {
                    attachmentMessageLocalId: 'new-session-attachment-local-1',
                },
            });
        });

        expect(uploadAttachmentDraftsToSessionSpy).toHaveBeenCalledWith({
            sessionId: 'sess_target',
            drafts,
            config: expect.any(Object),
            applyDraftPatch: expect.any(Function),
            messageLocalId: 'new-session-attachment-local-1',
        });
        expect(followUpSpawnedSessionWithServerScopeSpy).toHaveBeenCalledWith({
            sessionId: 'sess_target',
            targetServerId: 'server-a',
            initialMessageText: 'Investigate this bug\n\n[attachments block]',
            displayText: 'Investigate this bug',
            profileId: 'profile-work',
            messageLocalId: 'new-session-attachment-local-1',
            metaOverrides: {
                happier: {
                    kind: 'attachments.v1',
                    payload: {
                        attachments: [{
                            name: 'notes.txt',
                            path: '.happier/uploads/notes.txt',
                            mimeType: 'text/plain',
                            sizeBytes: 12,
                            sha256: 'abc123',
                        }],
                    },
                },
            },
        });
        expect(readNewSessionAttachmentDrafts('panel-follow-up')).toEqual([]);
    });

    it('shows review comments saved for the selected home-relative workspace', async () => {
        const { NewSessionSimplePanel } = await import('./NewSessionSimplePanel');

        AgentInputMock.mockClear();
        workspaceReviewDraftsState.draftsByRootPath.set('/Users/leeroy/Documents/Development/happier-demo-projects/atlas', [{
            id: 'draft-1',
            filePath: 'src/a.ts',
            source: 'diff',
            anchor: {
                kind: 'diffLine',
                startLine: 1,
                side: 'after',
                oldLine: 1,
                newLine: 1,
            },
            snapshot: {
                selectedLines: ['+export const a = 2;'],
                beforeContext: [],
                afterContext: [],
            },
            body: 'Please verify this project change.',
            createdAt: 1,
        }]);

        const props = {
            popoverBoundaryRef: { current: null } as unknown as React.RefObject<any>,
            headerHeight: 44,
            safeAreaTop: 0,
            safeAreaBottom: 0,
            newSessionTopPadding: 0,
            newSessionSidePadding: 0,
            newSessionBottomPadding: 0,
            containerStyle: {},
            promptStore: createNewSessionPromptStore(''),
            setSessionPrompt: () => {},
            handleCreateSession: () => {},
            canCreate: true,
            isCreating: false,
            emptyAutocompleteKinds: [],
            emptyAutocompleteSuggestions: async () => [],
            sessionPromptInputMaxHeight: 200,
            agentInputExtraActionChips: [],
            agentType: 'codex',
            handleAgentClick: () => {},
            permissionMode: 'default',
            handlePermissionModeChange: () => {},
            modelMode: 'default',
            setModelMode: () => {},
            modelOptions: [{ value: 'default', label: 'Default', description: '' }],
            connectionStatus: undefined,
            machineName: undefined,
            selectedMachineId: 'machine-1',
            selectedMachineHomeDir: '/Users/leeroy',
            selectedPath: '~/Documents/Development/happier-demo-projects/atlas',
            showResumePicker: false,
            resumeSessionId: null,
            isResumeSupportChecking: false,
            useProfiles: false,
            selectedProfileId: null,
            targetServerId: 'server-b',
        } satisfies React.ComponentProps<typeof NewSessionSimplePanel> & { selectedMachineHomeDir: string };

        await renderScreen(React.createElement(NewSessionSimplePanel, props));

        const inputProps = (AgentInputMock.mock.calls[0]?.[0] ?? {}) as any;
        const reviewCommentsChip = inputProps.extraActionChips.find((chip: any) => chip?.key === 'review-comments');
        expect(reviewCommentsChip).toBeTruthy();
        expect('composerAttachmentBadge' in reviewCommentsChip).toBe(false);
        expect(inputProps.attachmentRowItems).toContainEqual(expect.objectContaining({
            kind: 'badge',
            key: 'review-comments',
            testID: 'agent-input-review-comments-attachment-badge',
        }));
    });
});
