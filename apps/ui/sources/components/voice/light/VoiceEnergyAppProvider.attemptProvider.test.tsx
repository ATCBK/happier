import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storage';
import { setReducedMotionPreferenceOverride } from '@/hooks/ui/useReducedMotionPreference';
import { resetVoiceSessionStoreForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';

import {
    readReanimatedFrameCallbacks,
    resetReanimatedFrameCallbacks,
} from '@/dev/testkit/mocks/reanimated';
import { voiceRuntimeLevelStore, type VoiceRuntimeLevelWriter } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import { useVoiceEnergyPresence } from './useVoiceEnergy';
import { VoiceEnergyAppProvider } from './VoiceEnergyAppProvider';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = getStorage().getState();
const hostPresence = { focused: true };
const hostListeners = new Map<string, Set<() => void>>();

// Only browser/desktop globals are substituted; real host-presence hooks sample
// and subscribe to the same focus events used by the desktop renderer.
function installHostBoundary(): void {
    vi.stubGlobal('__TAURI_INTERNALS__', { invoke: () => undefined });
    vi.stubGlobal('document', {
        visibilityState: 'visible',
        hasFocus: () => hostPresence.focused,
        addEventListener: () => undefined,
    });
    vi.stubGlobal('addEventListener', (event: string, listener: () => void) => {
        const listeners = hostListeners.get(event) ?? new Set();
        listeners.add(listener);
        hostListeners.set(event, listeners);
    });
    for (const listener of hostListeners.get('focus') ?? []) listener();
}

function selectProvider(providerId: string): void {
    getStorage().setState((state) => ({ settings: {
        ...state.settings,
        voice: { ...state.settings.voice, providerId },
    } }));
}

/** A mounted Voice surface: the energy clock only runs while one is present. */
function VisibleConsumer(): null {
    const presence = useVoiceEnergyPresence();
    React.useEffect(() => {
        presence.acquire();
        return () => presence.release();
    }, [presence]);
    return null;
}

function latestFrameActivation(): boolean | null {
    const records = readReanimatedFrameCallbacks();
    expect(records).toHaveLength(1);
    return records[0]!.setActiveCalls.at(-1) ?? null;
}

/**
 * §2.4a's activation gate reads "a provider is resolved". That fact must come from the attempt
 * that is running, not from the selection: the selection names the *next* idle admission, so a
 * user who picks Off mid-conversation would otherwise freeze the light — the presence would stop
 * showing amplitude and settling while the microphone stayed open.
 */
describe('VoiceEnergyAppProvider attempt provider', () => {
    let tree: renderer.ReactTestRenderer | null = null;
    let input: VoiceRuntimeLevelWriter | null = null;

    beforeEach(() => {
        resetReanimatedFrameCallbacks();
        getStorage().setState(initialStorageState, true);
        resetVoiceSessionStoreForTests();
        setReducedMotionPreferenceOverride(false);
        hostPresence.focused = true;
        installHostBoundary();
    });

    afterEach(() => {
        act(() => { tree?.unmount(); input?.close(); });
        tree = null;
        input = null;
        standardCleanup();
        resetVoiceSessionStoreForTests();
        getStorage().setState(initialStorageState, true);
        setReducedMotionPreferenceOverride(null);
        vi.unstubAllGlobals();
    });

    async function renderProvider(): Promise<void> {
        await act(async () => {
            tree = renderer.create(
                <VoiceEnergyAppProvider>
                    <VisibleConsumer />
                </VoiceEnergyAppProvider>,
            );
        });
    }

    it('keeps the energy clock running for a live attempt after the selection changes to Off', async () => {
        selectProvider('off');
        setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: 'voice-attempt',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });

        input = voiceRuntimeLevelStore.open({ channel: 'input', sourceId: 'attempt-provider-test' });

        await renderProvider();
        act(() => input!.write(1));

        expect(latestFrameActivation()).toBe(true);
    });

    it('leaves the clock idle when nothing is running and nothing is selected', async () => {
        selectProvider('off');

        await renderProvider();

        expect(latestFrameActivation()).toBe(false);
    });

    it('stays still when a desktop window remains visible but loses focus', async () => {
        selectProvider('local_conversation');
        setVoiceSessionSnapshot({
            adapterId: 'local_conversation',
            sessionId: 'voice-attempt',
            status: 'connected',
            mode: 'listening',
            canStop: true,
        });
        // Context and other visible-window consumers still receive this fact. The
        // energy clock is the narrower focus projection, so it must stop here.
        hostPresence.focused = false;
        act(() => {
            for (const listener of hostListeners.get('blur') ?? []) listener();
        });

        await renderProvider();

        expect(latestFrameActivation()).toBe(false);
    });
});
