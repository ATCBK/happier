import { afterEach, describe, expect, it } from 'vitest';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import { waitForVoiceQaLifecycleController } from './waitForVoiceQaLifecycleController';

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createVoiceSessionLifecycleController } = await import('@/voice/session/voiceSessionLifecycleController');
let controller: ReturnType<typeof createVoiceSessionLifecycleController> | undefined;
afterEach(async () => {
    await controller?.dispose();
    controller = undefined;
});

describe('waitForVoiceQaLifecycleController', () => {
    it('waits for the production lifecycle owner instead of treating startup order as an idle session', async () => {
        const lifecycle = createVoiceSessionLifecycleController();
        controller = lifecycle;
        let published: typeof lifecycle | null = null;

        const resolved = await waitForVoiceQaLifecycleController({
            getController: () => published,
            timeoutMs: 100,
            wait: async () => { published = lifecycle; },
        });

        expect(resolved).toBe(controller);
    });

    it('waits until the production owner has consumed the configured provider', async () => {
        controller = createVoiceSessionLifecycleController();

        const resolved = await waitForVoiceQaLifecycleController({
            getController: () => controller ?? null,
            isReady: (candidate) => candidate.getConfiguredProviderId() === 'local_conversation',
            timeoutMs: 100,
            wait: async () => {
                controller?.setConfiguredProviderId('local_conversation');
            },
        });

        expect(resolved).toBe(controller);
        expect(resolved.getConfiguredProviderId()).toBe('local_conversation');
    });

    it('fails explicitly when the production lifecycle owner never becomes ready', async () => {
        let now = 0;

        await expect(waitForVoiceQaLifecycleController({
            getController: () => null,
            now: () => now,
            timeoutMs: 100,
            wait: async () => {
                now += 50;
            },
        })).rejects.toThrow('voice_qa_media_lifecycle_unavailable');
    });
});
