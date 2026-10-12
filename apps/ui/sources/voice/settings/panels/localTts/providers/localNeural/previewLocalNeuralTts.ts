import type { VoiceLocalTtsSettings } from '@/sync/domains/settings/voiceLocalTtsSettings';
import type { VoicePlaybackStopperRegistrar } from '@/voice/runtime/playback/VoicePlaybackController';
import { createVoicePlaybackController } from '@/voice/runtime/playback/VoicePlaybackController';
import { resolveKokoroDaemonTtsPackId } from '@/voice/kokoro/assets/resolveKokoroDaemonTtsPackId';
import { speakKokoroText } from '@/voice/output/KokoroTtsController';
import { DaemonTtsController } from '@/voice/runtime/daemonInference/DaemonTtsController';
import { resolveDaemonVoiceInferenceExecution } from '@/voice/runtime/daemonInference/daemonVoiceInferencePolicy';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { resolveLocalNeuralTtsOptions } from '@/voice/local/localVoiceSettings';

const playback = createVoicePlaybackController();
type Preview = Readonly<{ voiceId: string | null }>;
let activePreview: Preview | null = null;
const listeners = new Set<() => void>();
function publishPreview(next: Preview | null): void {
    const before = activePreview?.voiceId ?? null;
    activePreview = next;
    if (before === (next?.voiceId ?? null)) return;
    for (const listener of listeners) listener();
}

/** Native picker and Settings Actions share pending and active sample custody. */
export const localNeuralTtsPreviewController = {
    read: () => activePreview?.voiceId ?? null,
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
    stop(): boolean {
        const stopped = activePreview !== null;
        playback.interrupt();
        publishPreview(null);
        return stopped;
    },
    begin(voiceId: string | null) {
        playback.interrupt();
        const epoch = playback.captureEpoch();
        const isCurrent = () => playback.isEpochCurrent(epoch);
        publishPreview({ voiceId });
        return {
            registerPlaybackStopper: playback.registerStopper.captureAttempt!(),
            isCurrent,
            finish: () => {
                if (!isCurrent()) return;
                playback.interrupt();
                publishPreview(null);
            },
        };
    },
};

/** The same settings sample playback owner serves Test, the native voice picker and Actions. */
export async function previewLocalNeuralTts(input: Readonly<{
    config: VoiceLocalTtsSettings['localNeural'];
    sample: string;
    timeoutMs: number;
    registerPlaybackStopper: VoicePlaybackStopperRegistrar;
    signal?: AbortSignal;
    isCurrent?: () => boolean;
}>): Promise<void> {
    const options = resolveLocalNeuralTtsOptions(input.config);
    const execution = await resolveDaemonVoiceInferenceExecution({ requestedExecution: options.execution, surface: 'tts' });
    throwIfAborted(input.signal);
    if (input.isCurrent?.() === false) throw new Error('voice_preview_retired');
    if (execution === 'daemon') {
        await new DaemonTtsController().speak({ text: input.sample,
            packId: resolveKokoroDaemonTtsPackId(options.assetSetId), voiceId: options.voiceId,
            speed: options.speed, registerPlaybackStopper: input.registerPlaybackStopper, onSpeaking: () => {} });
        return;
    }
    await speakKokoroText({ text: input.sample, assetSetId: options.assetSetId, voiceId: options.voiceId,
        speed: options.speed, timeoutMs: input.timeoutMs, registerPlaybackStopper: input.registerPlaybackStopper });
}
