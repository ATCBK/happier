import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { createWorkflowAuthoringComposerCustody } from '@/components/sessions/authoring/authoringComposerCustody';
import { composerStructuredMentionsFromReferences } from '@/components/sessions/composer/composerScopeAdapters';
import { createNewSessionPromptStore } from '@/components/sessions/new/hooks/screenModel/newSessionPromptStore';
import { useNewSessionComposerDocument } from '@/components/sessions/new/hooks/screenModel/useNewSessionComposerDocument';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { consumeWorkflowEditorDraftSeed } from './workflowEditorDraftSeed';

import {
    buildNewSessionAutomationHandoffSeed,
    readNewSessionAutomationHandoffSeed,
    storeNewSessionAutomationHandoffSeed,
} from './newSessionAutomationHandoffSeed';
import type { SessionAuthoringDraft } from '@/components/sessions/authoring/draft/sessionAuthoringDraft';

const AGENT_TARGET = {
    kind: 'agent' as const,
    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
};

function authoringDraft(overrides?: Partial<SessionAuthoringDraft>): SessionAuthoringDraft {
    return {
        targetType: 'new_session',
        executionTarget: { kind: 'machine', target: { serverId: 'server-1', machineId: 'machine-1' } },
        directory: '/repo',
        checkoutCreationDraft: null,
        organizationPlacement: { folderId: null, tagIds: [] },
        prompt: 'Summarize the release notes',
        displayText: 'Summarize the release notes',
        agentTarget: AGENT_TARGET,
        transcriptStorage: null,
        profileId: null,
        environmentVariables: null,
        resumeSessionId: null,
        permissionMode: 'default',
        permissionModeUpdatedAt: 42,
        modelSelection: null,
        capabilitySelection: null,
        connectedServices: null,
        terminal: null,
        windowsRemoteSessionLaunchMode: null,
        windowsRemoteSessionConsole: null,
        windowsTerminalWindowName: null,
        runtimeDescriptorV1: null,
        acpSessionModeId: null,
        sessionConfigOptionOverrides: null,
        existingSessionId: null,
        sessionEncryptionMode: null,
        sessionEncryptionKeyBase64: null,
        sessionEncryptionVariant: null,
        automation: null,
        ...overrides,
    } as SessionAuthoringDraft;
}

const automationDraft = {
    enabled: true,
    name: 'Nightly notes',
    description: 'Summarize each night',
    triggers: [{
        clientId: 'schedule-1',
        definition: {
            kind: 'schedule' as const,
            enabled: true,
            schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null },
        },
    }],
};

afterEach(() => {
    standardCleanup();
});

describe('New Session → Automation handoff', () => {
    it('transfers the composed prompt, selections and exact placement', () => {
        const seed = buildNewSessionAutomationHandoffSeed({
            draftId: 'handoff-1',
            authoring: authoringDraft(),
            automation: automationDraft,
        });

        expect(seed.name).toBe('Nightly notes');
        expect(seed.description).toBe('Summarize each night');
        expect(seed.triggers).toEqual(automationDraft.triggers);
        expect(seed.project).toEqual({ machineId: 'machine-1', directory: '/repo' });
        const block = seed.draft.blocks[0]!;
        expect(block.kind === 'step' ? block.document.text : null).toBe('Summarize the release notes');
        // The selections travel through the same seam a saved one-shot
        // Automation uses, so nothing the person chose is silently dropped.
        expect(seed.draft.defaults.agentTarget).toEqual(AGENT_TARGET);
        expect(seed.draft.defaults.permissionMode).toBe('default');
    });

    /**
     * The chip hands over the live composer exactly as it stands. The saved
     * definition may only hold the portable projection, but the destination's
     * composer custody receives the exact document: the mention stays bound to
     * the second of two equal tokens, staged bytes stay (so Save can refuse
     * them rather than drop them) and the caret stays where it was.
     */
    it('hands the exact live composer to the destination and keeps the saved draft portable', () => {
        const text = 'Compare @issue with @issue';
        const secondTokenStart = 'Compare @issue with '.length;
        const stagedContent = {
            kind: 'stagedMedia' as const,
            handle: {
                v: 1 as const,
                id: 'stage-42',
                executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
                owner: { pluginId: 'acme.issues', localId: 'issue' },
                mediaKind: 'image' as const,
                mimeType: 'image/png',
                name: 'issue-42.png',
                sizeBytes: 12,
                sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
            },
        };
        const portableAttachment = {
            v: 1 as const,
            instanceId: 'attachment-staged',
            attachment: { pluginId: 'acme.issues', localId: 'issue' },
            key: 'issue-42',
            value: { issueId: 42 },
            presentation: { label: 'Issue #42', typeLabel: 'Issue' },
        };
        const snapshot = {
            // The render projection still says "Summarize the release notes";
            // this is what the person can actually see.
            text,
            references: [{
                kind: 'partner.reference',
                ref: 'partner:issue-42',
                token: '@issue',
                label: 'Issue #42',
                start: secondTokenStart,
                end: secondTokenStart + '@issue'.length,
            }],
            attachments: [{
                ...portableAttachment,
                content: stagedContent,
                availability: { status: 'ready' },
            }],
            selection: { start: 4, end: 9 },
        };

        const seed = buildNewSessionAutomationHandoffSeed({
            draftId: 'handoff-live',
            authoring: authoringDraft(),
            automation: automationDraft,
            composer: snapshot as never,
        });

        const block = seed.draft.blocks[0]!;
        if (block.kind !== 'step') throw new Error('unreachable');
        // The saved definition stays portable: no offsets, no device bytes.
        expect(block.document).toEqual({
            text,
            references: [{
                kind: 'partner.reference',
                ref: 'partner:issue-42',
                token: '@issue',
                label: 'Issue #42',
            }],
            attachments: [portableAttachment],
        });
        // The exact document travels privately, for that same block.
        expect(seed.composer?.blockId).toBe(block.id);
        expect(seed.composer?.selection).toEqual({ start: 4, end: 9 });
        expect(seed.composer?.document.text).toBe(text);
        expect(seed.composer?.document.structuredInputMentions).toEqual([expect.objectContaining({
            ref: 'partner:issue-42',
            start: secondTokenStart,
            end: secondTokenStart + '@issue'.length,
        })]);
        expect(seed.composer?.document.composerAttachments).toEqual([
            { ...portableAttachment, content: stagedContent },
        ]);
    });

    it('hands an empty live composer to the editor as an incomplete draft', () => {
        const seed = buildNewSessionAutomationHandoffSeed({
            draftId: 'handoff-empty',
            authoring: authoringDraft({ prompt: 'stale rendered prompt', displayText: 'stale rendered prompt' }),
            automation: automationDraft,
            composer: {
                text: '',
                references: [],
                attachments: [],
                selection: { start: 0, end: 0 },
            },
        });

        const block = seed.draft.blocks[0]!;
        expect(block.kind).toBe('step');
        if (block.kind !== 'step') throw new Error('unreachable');
        expect(block.document).toEqual({ text: '', references: [], attachments: [] });
        expect(seed.composer?.document.text).toBe('');
    });

    /**
     * The whole corridor, from the live New Session input to the destination
     * block: the caret the input reports through its persistence seam is in
     * the snapshot the chip reads, and the destination's custody adopts it
     * once beside the exact second-occurrence mention.
     */
    it('carries the live New Session caret and exact duplicate mention into destination custody', async () => {
        const text = 'Compare @issue with @issue';
        const secondTokenStart = 'Compare @issue with '.length;
        const hook = await renderHook(() => useNewSessionComposerDocument({
            promptStore: createNewSessionPromptStore(text),
            persistedAttachments: [],
            composerAttachmentEntriesById: {},
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));
        await act(async () => {
            hook.getCurrent().onStructuredInputMentionsChange(composerStructuredMentionsFromReferences({
                references: [{
                    kind: 'partner.reference',
                    ref: 'partner:issue-42',
                    token: '@issue',
                    label: 'Issue #42',
                    start: secondTokenStart,
                    end: secondTokenStart + '@issue'.length,
                }],
                existing: [],
            }));
            hook.getCurrent().inputPersistence.onSelectionChangePersist({ start: 8, end: 14 }, text.length);
        });

        const snapshot = hook.getCurrent().readCurrentDocumentSnapshot();
        expect(snapshot?.selection).toEqual({ start: 8, end: 14 });

        const seed = buildNewSessionAutomationHandoffSeed({
            draftId: 'handoff-corridor',
            authoring: authoringDraft({ prompt: 'stale render', displayText: 'stale render' }),
            automation: automationDraft,
            ...(snapshot === null ? {} : { composer: snapshot }),
        });
        const block = seed.draft.blocks[0]!;
        const custody = createWorkflowAuthoringComposerCustody('handoff-corridor', seed.composer ? [seed.composer] : []);
        const entry = custody.entryFor(block.id);
        const owner = entry.resolveDocumentOwner({
            capabilities: { text: true, references: true, attachments: true, submit: true },
            createInitialDocument: () => ({ text: 'rebuilt', structuredInputMentions: [], composerAttachments: [] }),
        });

        expect(entry.readSelection()).toEqual({ start: 8, end: 14 });
        expect(owner.read().document.text).toBe(text);
        expect(owner.read().document.structuredInputMentions).toEqual([expect.objectContaining({
            ref: 'partner:issue-42',
            start: secondTokenStart,
            end: secondTokenStart + '@issue'.length,
        })]);

        await hook.unmount();
    });

    it('omits a caret that no longer lies inside the live New Session text', async () => {
        const promptStore = createNewSessionPromptStore('A long draft prompt');
        const hook = await renderHook(() => useNewSessionComposerDocument({
            promptStore,
            persistedAttachments: [],
            composerAttachmentEntriesById: {},
            scopeKey: 'server-a/account-a',
            canSubmitRef: { current: true },
            isSubmitting: false,
        }));
        await act(async () => {
            hook.getCurrent().inputPersistence.onSelectionChangePersist({ start: 15, end: 19 }, 19);
            promptStore.setPrompt('Short');
        });

        expect(hook.getCurrent().readCurrentDocumentSnapshot()?.selection).toBeUndefined();

        await hook.unmount();
    });

    it('retains a handoff until committed intake, then refuses history reuse', () => {
        const profileScope = getStorage().getState().profileScope;
        const snapshot = getAppliedActiveServerSnapshot();
        const available = isAppliedActiveServerRuntimeAvailable();
        getStorage().setState({ profileScope: { serverId: 'server-a', accountId: 'account-a' } });
        publishAppliedActiveServerSnapshot({ ...snapshot, serverId: 'server-a' });
        try {
            const seedId = storeNewSessionAutomationHandoffSeed(buildNewSessionAutomationHandoffSeed({
                draftId: 'handoff-once',
                authoring: authoringDraft(),
                automation: automationDraft,
            }));

            expect(readNewSessionAutomationHandoffSeed(seedId)?.name).toBe('Nightly notes');
            expect(readNewSessionAutomationHandoffSeed(seedId)?.name).toBe('Nightly notes');
            consumeWorkflowEditorDraftSeed(seedId);
            expect(readNewSessionAutomationHandoffSeed(seedId)).toBeNull();
        } finally {
            getStorage().setState({ profileScope });
            publishAppliedActiveServerSnapshot(snapshot, available);
        }
    });

    it('still transfers the authored prompt when no placement is resolved yet', () => {
        const seed = buildNewSessionAutomationHandoffSeed({
            draftId: 'handoff-2',
            authoring: authoringDraft({ executionTarget: null, agentTarget: null }),
            automation: { ...automationDraft, triggers: [] },
        });

        const block = seed.draft.blocks[0]!;
        expect(block.kind === 'step' ? block.document.text : null).toBe('Summarize the release notes');
        // No machine was chosen, so the destination shows placement as
        // unresolved rather than inventing one.
        expect(seed.project).toBeNull();
    });
});
