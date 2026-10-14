import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import {
    getStorage, loadLocalVoiceEngineWithCompatState, localVoiceHomeId,
    registerLocalVoiceEngineHarnessHooks, warmLocalVoiceEngineHarnessGraph,
} from '@/voice/local/localVoiceEngine.testHarness';
import { createSessionFixture, renderScreen, standardCleanup } from '@/dev/testkit';

// The canonical local-engine harness owns OS/audio and Home HTTP/Socket boundaries.
// Runtime, lifecycle, settings, retained target, model and rendered consumers are real.
const restoreLoader = await warmLocalVoiceEngineHarnessGraph();
registerLocalVoiceEngineHarnessHooks({ resetModulesBetweenTests: false });
const { VoiceSessionRuntime } = await import('@/voice/session/VoiceSessionRuntime');
const { useVoiceSurfaceModel } = await import('@/components/voice/surface/useVoiceSurfaceModel');
const { VoiceGlance } = await import('./VoiceGlance');
const { VoiceCompactTranscript } = await import('./VoiceCompactTranscript');
const { VoiceTopBarPresence } = await import('./VoiceTopBarPresence');
const { VoiceOrb } = await import('./VoiceOrb');
const { useSharedValue } = await import('react-native-reanimated');
const { getVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleControllerStore');
const { getVoiceSessionEndedAttempt } = await import('@/voice/session/voiceSessionStore');
const { getSessionName } = await import('@/utils/sessions/sessionUtils');
const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
const { t } = await import('@/text');

afterAll(restoreLoader);
afterEach(standardCleanup);

describe('retained ended Voice target presentation', () => {
    it.each(['session_root', 'voice_home'] as const)(
        'retains the effective %s target after starting a continued carrier and ending', async kind => {
            await loadLocalVoiceEngineWithCompatState();
            const storage = await getStorage();
            const { readLocalConversationVoiceSettings } = await import('@/sync/domains/settings/voiceSettings');
            const { buildSystemSessionMetadataV1 } = await import('@happier-dev/protocol/sessions/control/contract');
            const { writeVoiceConversationScopeMetadata } = await import('@/voice/persistence/voiceConversationScopeMetadata');
            const { writeVoiceConversationBindingMetadata } = await import('@/voice/binding/voiceConversationBindingMetadata');
            const { VOICE_AGENT_GLOBAL_SESSION_ID } = await import('@/voice/agent/voiceAgentGlobalSessionId');
            const { getVoiceSessionPresentedBinding } = await import('@/voice/session/voiceSessionStore');
            const carrier = { serverId: localVoiceHomeId, sessionId: 'continued-carrier' };
            const target = kind === 'session_root' ? { serverId: localVoiceHomeId, sessionId: 's1' } : null;
            const scope = kind === 'session_root'
                ? { kind, sessionRootId: 's1' } : { kind };
            const binding = {
                adapterId: 'local_conversation', controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
                conversationSessionId: carrier.sessionId, conversationSessionAddress: carrier,
                targetSessionAddress: target, transcriptMode: 'native_session' as const, updatedAt: Date.now(),
            };
            const voice = storage.getState().settings.voice;
            const config = readLocalConversationVoiceSettings(voice);
            storage.__setState({ sessions: { ...storage.getState().sessions,
                [carrier.sessionId]: createSessionFixture({ id: carrier.sessionId, serverId: carrier.serverId,
                    metadata: writeVoiceConversationBindingMetadata(writeVoiceConversationScopeMetadata({
                        ...createSessionFixture().metadata!,
                        ...buildSystemSessionMetadataV1({ key: 'voice_conversation', hidden: true }),
                        path: '/repo', host: 'test', flavor: 'claude', machineId: 'machine-1',
                    }, scope), binding),
                }),
            }, settings: { ...storage.getState().settings,
                voice: voiceSettingsParse({ ...voice, providerId: 'local_conversation',
                    executionMachine: { mode: 'fixed', machineId: 'machine-1' },
                    providers: { ...voice.providers, local_conversation: { schemaVersion: 1,
                        config: { ...config, conversationMode: 'agent', agent: { ...config.agent, prewarmOnConnect: false } },
                    } },
                }),
            } });
            const view = await renderScreen(<VoiceSessionRuntime />);
            try {
                const controller = getVoiceSessionLifecycleController()!;
                await act(async () => { await controller.toggle(carrier); });
                expect(controller.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
                expect(controller.getAttemptTargetSessionAddress()).toEqual(carrier);
                expect(getVoiceSessionPresentedBinding()).toMatchObject({
                    conversationSessionAddress: carrier, targetSessionAddress: target,
                });
                await act(async () => { await controller.stop(controller.getSnapshot().sessionId!); });
                expect(getVoiceSessionEndedAttempt()).toMatchObject({
                    conversationSessionAddress: carrier, targetSessionAddress: target,
                    accountScope: { serverId: localVoiceHomeId, accountId: 'account-a' },
                    reason: { kind: 'stopped' },
                });
            } finally {
                await view.unmount();
            }
        },
    );
    it('keeps the exact direct-session name in the compact caption and glance header after End', async () => {
        await loadLocalVoiceEngineWithCompatState();
        const storage = await getStorage();
        const target = { serverId: localVoiceHomeId, sessionId: 's1' };
        storage.__setState({ sessions: { ...storage.getState().sessions,
            [target.sessionId]: createSessionFixture({ id: target.sessionId, serverId: target.serverId,
                metadata: { path: '/repo', host: 'test', name: 'Release captain', flavor: 'claude', machineId: 'machine-1' },
            }),
        } });
        const targetSession = storage.getState().sessions[target.sessionId];
        if (!targetSession) throw new Error('Expected the canonical local-engine target fixture');
        const name = getSessionName(targetSession, target.serverId);
        expect(name).toBe('Release captain');
        storage.__setState({ settings: { ...storage.getState().settings,
            voice: voiceSettingsParse({ ...storage.getState().settings.voice, providerId: 'local_conversation',
                executionMachine: { mode: 'fixed', machineId: 'machine-1' },
            }),
        } });

        const presentation: { current: ReturnType<typeof useVoiceSurfaceModel> } = { current: null };
        function PresentedVoice() {
            const anchorRef = React.useRef<import('react-native').View | null>(null);
            const translateX = useSharedValue(0);
            presentation.current = useVoiceSurfaceModel({ variant: 'session', sessionAddress: target });
            return presentation.current ? <>
                <VoiceCompactTranscript voice={presentation.current.attemptControl} />
                <VoiceTopBarPresence voice={presentation.current.attemptControl} />
                <VoiceOrb voice={presentation.current.attemptControl} anchorRef={anchorRef}
                    sectionOpen={false} onOpenSection={() => {}} shouldSuppressPress={() => false}
                    translateX={translateX} hostWidth={1440} />
                <VoiceGlance model={presentation.current} presentation="popover" />
            </> : null;
        }
        const view = await renderScreen(<><VoiceSessionRuntime /><PresentedVoice /></>);
        try {
            await act(async () => { await getVoiceSessionLifecycleController()!.toggle(target); });
            expect(presentation.current!.attemptControl.live).toBe(true);
            const header = () => view.findAll(node => node.props?.testID === 'voice-glance' && typeof node.props?.title === 'string')[0]!;
            expect(header().props.title).toBe(t('sessionVoice.talkingTo', { name }));
            await act(async () => { await getVoiceSessionLifecycleController()!.stop(target.sessionId); });
            expect(presentation.current!.attemptControl.live).toBe(false);
            expect(getVoiceSessionEndedAttempt()?.targetSessionAddress).toEqual(target);
            expect(presentation.current!.attemptControl.targetSessionAddress).toEqual(target);
            expect(view.tree.root.findByProps({ testID: 'voice-compact-transcript' }).props.children).toBe(name);
            expect(header().props.title).toBe(name);
            expect(header().props.source).toBe(presentation.current!.providerLabel);
            expect(header().props.mark).toBeDefined();
            expect(view.findHostByTestId('voice-top-bar-target')?.props.accessibilityLabel).toBe(name);
            expect(view.findHostByTestId('voice-orb-target')?.props.accessibilityLabel).toBe(name);
        } finally {
            await view.unmount();
        }
    });
});
