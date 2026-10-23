import { afterEach, describe, expect, it } from 'vitest';
import type { Message } from '@happier-dev/session-core/messages';

import { renderHook, type RenderHookResult } from '@/dev/testkit/hooks/renderHook';
import type { VoiceMarkEvent } from '@/components/voice/presence/resolveVoiceMarkPose';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';

import { useVoiceSetupFirstSuccessEvent } from './useVoiceSetupFirstSuccessEvent';
import { deriveVoiceSetupFacts } from './voiceSetupFacts';

type Props = Readonly<{ complete: boolean; live: boolean; messages?: readonly Message[];
    attemptId?: string; conversationId?: string; lifetime?: ServerAccountScopeLifetime; liveInputIds?: readonly string[] }>;
const lifetime: ServerAccountScopeLifetime = { scope: { serverId: 'home', accountId: 'account' },
    isCurrent: () => true, onRetire: () => ({ dispose() {} }) };
const meta = { happier: { kind: 'conversation_turn.v1', payload: { v: 1 },
    conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' } } } as const;
const turn: readonly Message[] = [
    { kind: 'user-text', id: 'input', localId: 'voice-realtime:current:user:input', seq: 11, createdAt: 10, text: 'hello', meta },
    { kind: 'agent-text', id: 'reply', localId: 'voice-realtime:current:assistant:reply', seq: 12, createdAt: 20, text: 'Hi', meta },
];
let hook: RenderHookResult<VoiceMarkEvent | null, Props> | null = null;
afterEach(async () => {
    await hook?.unmount();
    hook = null;
});

const mount = async (initialProps: Props) => {
    hook = await renderHook((props: Props) => {
        const observation = {
            attemptId: props.attemptId ?? 'voice-attempt:1',
            conversation: { serverId: 'home', sessionId: props.conversationId ?? 'conversation' },
            lifetime: props.lifetime ?? lifetime, afterSeq: 10, messages: props.messages ?? [],
            liveInputIds: props.liveInputIds ?? (props.live ? [turn[0]!.localId!] : []),
        };
        return useVoiceSetupFirstSuccessEvent(props.complete, props.live, observation);
    }, { initialProps });
    return hook;
};

describe('useVoiceSetupFirstSuccessEvent', () => {
    it('refuses delayed acknowledgements from an older attempt even above the Try sequence boundary', async () => {
        const h = await mount({ complete: false, live: true });
        const delayed = turn.map((message) => ({ ...message, localId: message.localId!.replace(':current:', ':old:') }));
        expect(deriveVoiceSetupFacts({ providerId: 'test.service', readiness: null,
            microphonePermission: 'unknown', messages: delayed }).firstTurnComplete).toBe(true);
        await h.rerender({ complete: true, live: false, messages: delayed });
        expect(h.getCurrent()).toBeNull();
    });
    it('does not celebrate another Local attempt whose reply was committed before its input', async () => {
        const h = await mount({ complete: false, live: true, liveInputIds: ['current-local-input'] });
        const delayed: readonly Message[] = [
            { ...turn[0]!, localId: 'old-local-input', seq: 12 },
            { ...turn[1]!, localId: 'old-stream:assistant', seq: 11, meta: { happier: {
                kind: 'voice_agent_turn.v1', payload: { v: 1, epoch: 0, role: 'assistant',
                    voiceAgentId: 'old-run', streamId: 'old-stream', ts: 20 },
            } } },
        ];
        await h.rerender({ complete: true, live: true, messages: delayed, liveInputIds: ['current-local-input'] });
        expect(h.getCurrent()).toBeNull();
    });
    it.each([true, false])('does not celebrate old acknowledged rows hydrating after a live Try (still live: %s)', async (live) => {
        const h = await mount({ complete: false, live: false });
        await h.rerender({ complete: false, live: true });
        const meta = { happier: { kind: 'conversation_turn.v1', payload: { v: 1 },
            conversationTurnOriginV1: { v: 1, channel: 'realtime_conversation', modality: 'voice' } } } as const;
        // Both rows belong to an older attempt, not the Try just observed by this mount.
        const messages: readonly Message[] = [
            { kind: 'user-text', id: 'retained-input', localId: 'voice-realtime:old:user:input',
                seq: 1, createdAt: 10, text: 'hello', meta },
            { kind: 'agent-text', id: 'retained-reply', localId: 'voice-realtime:old:assistant:reply',
                seq: 2, createdAt: 20, text: 'Hi', meta },
        ];
        const facts = deriveVoiceSetupFacts({ providerId: 'test.service', readiness: null,
            microphonePermission: 'unknown', messages });
        // Historical completion stays readable; only the new-success animation is refused.
        expect(facts.firstTurnComplete).toBe(true);
        await h.rerender({ complete: facts.firstTurnComplete, live, messages });
        expect(h.getCurrent()).toBeNull();
    });

    it('is the first success only when it completes here, after the person tried', async () => {
        const h = await mount({ complete: false, live: false });
        expect(h.getCurrent()).toBeNull();
        await h.rerender({ complete: false, live: true, messages: [turn[0]!] });
        expect(h.getCurrent()).toBeNull();
        // The reply may land just after the person ends the try.
        await h.rerender({ complete: true, live: false, messages: turn });
        const event = h.getCurrent();
        expect(event).toEqual({ kind: 'gather', id: 'voice-attempt:1:first-success' });
        await h.rerender({ complete: true, live: true, messages: turn });
        expect(h.getCurrent()).toBe(event);
    });

    it('never gathers for history: already complete, or completed by hydration without a try', async () => {
        const done = await mount({ complete: true, live: false });
        await done.rerender({ complete: true, live: true });
        expect(done.getCurrent()).toBeNull();
        await done.unmount();
        const hydrated = await mount({ complete: false, live: false });
        await hydrated.rerender({ complete: true, live: false });
        expect(hydrated.getCurrent()).toBeNull();
    });

    it.each(['account', 'conversation', 'attempt'] as const)('does not carry a Try across %s replacement', async (replacement) => {
        const h = await mount({ complete: false, live: true, messages: [turn[0]!] });
        await h.rerender({ complete: true, live: false, messages: turn,
            ...(replacement === 'account' ? { lifetime: { ...lifetime, scope: { ...lifetime.scope, accountId: 'other' } } } : {}),
            ...(replacement === 'conversation' ? { conversationId: 'other' } : {}),
            ...(replacement === 'attempt' ? { attemptId: 'voice-attempt:2' } : {}),
        });
        expect(h.getCurrent()).toBeNull();
    });

    it('refuses recovered history above the boundary and a greeting from another transcript attempt', async () => {
        const h = await mount({ complete: false, live: true });
        const recovered = turn.map((message) => ({ ...message, transcriptObservationProvenance: { kind: 'non_dependent', source: 'history' } as const }));
        await h.rerender({ complete: true, live: true, messages: recovered });
        expect(h.getCurrent()).toBeNull();
        await h.unmount();
        const other = await mount({ complete: false, live: true });
        await other.rerender({ complete: true, live: true, messages: [turn[0]!, { ...turn[1]!, localId: 'voice-realtime:other:assistant:greeting' }] });
        expect(other.getCurrent()).toBeNull();
    });

    it('emits for a genuine acknowledged pair while live, once, and never replays on remount', async () => {
        const h = await mount({ complete: false, live: false });
        await h.rerender({ complete: false, live: true });
        await h.rerender({ complete: true, live: true, messages: turn });
        const event = h.getCurrent();
        expect(event?.id).toBe('voice-attempt:1:first-success');
        await h.rerender({ complete: true, live: true, messages: [...turn] });
        expect(h.getCurrent()).toBe(event);
        await h.unmount();
        const remounted = await mount({ complete: true, live: true, messages: turn });
        expect(remounted.getCurrent()).toBeNull();
    });
});
