import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { standardCleanup } from '@/dev/testkit';
import {
    createRetainedVoiceAgentRpcBoundary, createStandaloneVoicePolicyHarness, prepareStandaloneVoicePolicyHarness,
} from '@/dev/testkit/harness/standaloneVoicePolicyHarness';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { ExecutionRunActionRequestSchema, ExecutionRunActionResponseSchema } from '@happier-dev/protocol/execution/runs/index';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { VOICE_TRANSCRIPT_MEMORY_KEY } from '@/voice/persistence/voiceTranscriptMemory';
import { encodeBase64StoredJsonContentEnvelope } from '@/sync/encryption/base64StoredJsonContent';

vi.mock('socket.io-client', async original =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));

let fixture: Awaited<ReturnType<typeof createStandaloneVoicePolicyHarness>>;
let execution: ReturnType<typeof import('./VoiceExecutionTransport').createVoiceExecutionTransport>;
let storage: typeof import('@/sync/domains/state/storage').storage;
let artifacts: ReturnType<typeof createArtifactStoreBoundary>;
let rpc: Awaited<ReturnType<typeof createRetainedVoiceAgentRpcBoundary>>;
const welcomeRequests: Array<ReturnType<typeof ExecutionRunActionRequestSchema.parse>> = [];
let assistantReplyText = 'Welcome!';
let preparedInstructionsFor: { serverId: string; sessionId: string } | undefined;
let beforeWelcomeReply: (() => void) | undefined;

await prepareStandaloneVoicePolicyHarness();

async function applyWelcomePreference(options: Readonly<{ assistantLanguage?: string; templateId?: string | null }> = {}) {
    const { normalizeVoiceSettingsLocalDelta } = await import('@/sync/domains/settings/voiceSettingsPersistence');
    const { readLocalConversationVoiceSettings, writeVoiceProviderSettingsConfig } = await import('@/sync/domains/settings/voiceSettings');
    const current = storage.getState().settings;
    const local = readLocalConversationVoiceSettings(current.voice);
    const voice = writeVoiceProviderSettingsConfig(current.voice, 'local_conversation', {
        ...local, agent: { ...local.agent, transcript: { ...local.agent.transcript, persistenceMode: 'persistent' } },
    });
    storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: {
        ...voice,
        ...(options.assistantLanguage ? { assistantLanguage: options.assistantLanguage } : {}),
        welcome: { ...voice.welcome, enabled: true, mode: 'immediate',
            ...(options.templateId !== undefined ? { templateId: options.templateId } : {}) },
    } }, current));
}

async function readRunMetadata() {
    const { readVoiceAgentRunMetadataFromSession } = await import('@/voice/persistence/voiceAgentRunMetadata');
    return readVoiceAgentRunMetadataFromSession({
        sessionId: fixture.sessionId, serverId: fixture.handle.accountLifetime.scope.serverId,
    });
}

describe('Voice welcome through retained initialization, execution cache and Home persistence', () => {
    beforeEach(async () => {
        welcomeRequests.length = 0;
        assistantReplyText = 'Welcome!';
        preparedInstructionsFor = undefined;
        beforeWelcomeReply = undefined;
        ({ storage } = await import('@/sync/domains/state/storage'));
        artifacts = createArtifactStoreBoundary({
            ownerAccountId: () => storage.getState().profileScope?.accountId ?? null, encryptionMode: 'plain',
        });
        rpc = await createRetainedVoiceAgentRpcBoundary({ runId: 'welcome-run',
            async handleOtherRpc(method, input) {
                if (method !== SESSION_RPC_METHODS.EXECUTION_RUN_ACTION) throw new Error('Unexpected Voice RPC: ' + method);
                const request = ExecutionRunActionRequestSchema.parse(input);
                if (request.actionId !== 'voice_agent.welcome') throw new Error('Unexpected Voice Action: ' + request.actionId);
                welcomeRequests.push(request);
                beforeWelcomeReply?.();
                return ExecutionRunActionResponseSchema.parse({ ok: true, result: { assistantText: assistantReplyText,
                    ...(preparedInstructionsFor ? { preparedInstructionsFor } : {}) } });
            },
        });
        fixture = await createStandaloneVoicePolicyHarness({
            mode: 'immediate', existingSession: { id: 'sys_voice' }, dispatch: rpc.dispatch,
            handleRequest: async (path, init) => await artifacts.handle(path, init),
        });
        await fixture.transcriptMemory.handleFetch('https://fixture.test/v1/kv', { method: 'POST',
            body: JSON.stringify({ mutations: [{ key: VOICE_TRANSCRIPT_MEMORY_KEY, version: -1,
                value: encodeBase64StoredJsonContentEnvelope({ t: 'plain', v: { v: 1, epoch: 1 } }),
            }] }),
        });
        await applyWelcomePreference();
        const { createVoiceExecutionTransport } = await import('./VoiceExecutionTransport');
        execution = createVoiceExecutionTransport();
        // Cache admission remains the real initializer/recovery path. Rejection
        // below is armed only after its initial metadata publication completes.
        await execution.ensureRunning(fixture.sessionId);
        expect(execution.isActive(fixture.sessionId)).toBe(true);
    });

    afterEach(async () => {
        try { await execution?.stop(fixture.sessionId); }
        finally { await fixture?.dispose(); standardCleanup(); }
    });

    it('retries immediate welcome when welcomedEpoch was not persisted', async () => {
        fixture.sessionHttp.rejectNextPatch(fixture.sessionId);
        await expect(execution.ensureRunningAndMaybeWelcome(fixture.sessionId)).resolves.toBe('Welcome!');
        fixture.sessionHttp.rejectNextPatch(fixture.sessionId);
        await expect(execution.ensureRunningAndMaybeWelcome(fixture.sessionId)).resolves.toBe('Welcome!');

        expect(welcomeRequests).toHaveLength(2);
        expect(welcomeRequests[0]?.input).toMatchObject({ welcomeText: expect.stringMatching(/Bonjour/) });
        expect((await readRunMetadata())?.welcomedEpoch).toBeUndefined();
    });
    it('publishes an actual welcome instruction receipt into its current local attempt', async () => {
        const { voiceConversationRuntimeMachine: machine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        machine.reset();
        machine.transitionToConnecting({ controlSessionId: fixture.sessionId });
        preparedInstructionsFor = { serverId: fixture.handle.accountLifetime.scope.serverId, sessionId: fixture.sessionId };
        try {
            await execution.ensureRunningAndMaybeWelcome(fixture.sessionId);
            expect(machine.getSnapshot().preparedInstructionsFor).toEqual(preparedInstructionsFor);
        } finally { machine.reset(); }
    });
    it('does not publish a welcome receipt after the bound target changes during delivery', async () => {
        const { voiceConversationRuntimeMachine: machine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        const { bindVoiceRuntimeAttemptBinding, createVoiceRuntimeAttemptBindingOwner, unbindVoiceRuntimeAttemptBindingIfOwned } = await import('@/voice/binding/voiceConversationBindingStore');
        const owner = createVoiceRuntimeAttemptBindingOwner();
        const serverId = fixture.handle.accountLifetime.scope.serverId;
        const binding = { adapterId: 'local_conversation', controlSessionId: fixture.sessionId, conversationSessionId: fixture.sessionId,
            conversationSessionAddress: { serverId, sessionId: fixture.sessionId }, targetSessionAddress: { serverId, sessionId: 'target-a' },
            transcriptMode: 'native_session' as const, lifetime: 'runtime_attempt' as const, updatedAt: 1 };
        bindVoiceRuntimeAttemptBinding({ owner, binding });
        machine.reset();
        machine.transitionToConnecting({ controlSessionId: fixture.sessionId });
        preparedInstructionsFor = binding.targetSessionAddress;
        beforeWelcomeReply = () => bindVoiceRuntimeAttemptBinding({ owner, binding: { ...binding,
            targetSessionAddress: { serverId, sessionId: 'target-b' }, updatedAt: 2 } });
        try {
            await execution.ensureRunningAndMaybeWelcome(fixture.sessionId);
            expect(machine.getSnapshot().preparedInstructionsFor).toBeUndefined();
        } finally {
            unbindVoiceRuntimeAttemptBindingIfOwned({ conversationSessionId: fixture.sessionId, owner });
            machine.reset();
        }
    });

    it('suppresses duplicate welcome once welcomedEpoch is persisted', async () => {
        await expect(execution.ensureRunningAndMaybeWelcome(fixture.sessionId)).resolves.toBe('Welcome!');
        await expect(execution.ensureRunningAndMaybeWelcome(fixture.sessionId)).resolves.toBeNull();

        expect(welcomeRequests).toHaveLength(1);
        expect(fixture.sessionHttp.writes).toContain(fixture.sessionId);
        expect(await readRunMetadata()).toMatchObject({ welcomedEpoch: 1 });
    });

    it('uses the retained run reply language instead of changed preferences', async () => {
        assistantReplyText = 'Bonjour!';
        expect(rpc.readRetainedRun()?.voicePolicy?.assistantLanguage).toBe('fr-FR');
        await applyWelcomePreference({ assistantLanguage: 'de-DE' });
        // A fresh process-local cache must reattach to the daemon's retained
        // policy, not snapshot the newly changed Account preference.
        const { createVoiceExecutionTransport } = await import('./VoiceExecutionTransport');
        execution = createVoiceExecutionTransport();
        await execution.ensureRunningAndMaybeWelcome(fixture.sessionId);
        expect(welcomeRequests[0]?.input).toMatchObject({ welcomeText: expect.stringMatching(/Bonjour/) });
    });

    it.each(['  Bonjour Atlas.\nKeep this spacing.  ', ' \n ', ''])('delivers the admitted custom greeting byte-for-byte instead of replacing it with the language default: %j', async text => {
        assistantReplyText = 'Custom welcome';
        // A selected Account Doc is the real producer of literal policy bytes.
        // Retire the initial Run before selecting the new greeting, so the
        // fresh public Ensure admission (not an authored handle) captures it.
        await execution.stop(fixture.sessionId);
        const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(fixture.handle.accountLifetime.scope.serverId);
        try {
            await account.createArtifactDocument({ artifactId: 'welcome-doc',
                header: { v: 1, kind: 'prompt_doc.v2', title: 'Welcome' },
                body: JSON.stringify({ v: 1, markdown: text, createdAtMs: 1, updatedAtMs: 1 }),
            });
        } finally { account.dispose(); }
        await applyWelcomePreference({ templateId: 'welcome-doc' });
        await execution.ensureRunningAndMaybeWelcome(fixture.sessionId);
        expect(rpc.readRetainedRun()?.voicePolicy?.welcome.text).toBe(text);
        expect(welcomeRequests[0]?.input).toEqual({ welcomeText: text });
        expect(artifacts.readPlainBody('welcome-doc')).toBe(JSON.stringify({ v: 1, markdown: text, createdAtMs: 1, updatedAtMs: 1 }));
    });

    it('leaves unsupported reply languages to the run model greeting policy', async () => {
        assistantReplyText = 'مرحبا';
        await execution.stop(fixture.sessionId);
        await applyWelcomePreference({ assistantLanguage: 'ar-SA' });
        await execution.ensureRunningAndMaybeWelcome(fixture.sessionId);
        expect(rpc.readRetainedRun()?.voicePolicy).toMatchObject({ assistantLanguage: 'ar-SA' });
        expect(welcomeRequests).toHaveLength(1);
        expect(welcomeRequests[0]?.input).toBeUndefined();
    });
});
