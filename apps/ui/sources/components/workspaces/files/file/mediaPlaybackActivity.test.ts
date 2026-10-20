import { describe, expect, it } from 'vitest';

import { resolveMediaPlaybackActivity } from './mediaPlaybackActivity';

describe('media playback activity', () => {
    const foreground = {
        isActive: true, destinationFocused: true, hostVisible: true,
        platform: 'web', isFullscreen: false, voiceOutputActive: false,
    };

    it('pauses for voice output while retaining source admission', () => {
        expect(resolveMediaPlaybackActivity({ ...foreground, voiceOutputActive: true }))
            .toEqual({ enabled: true, playbackAllowed: false });
    });

    it('preserves Android fullscreen playback while pausing ordinary background and blurred bodies', () => {
        expect(resolveMediaPlaybackActivity({ ...foreground, platform: 'android', hostVisible: false, isFullscreen: true }).playbackAllowed).toBe(true);
        expect(resolveMediaPlaybackActivity({ ...foreground, platform: 'android', hostVisible: false }).playbackAllowed).toBe(false);
        expect(resolveMediaPlaybackActivity({ ...foreground, hostVisible: false, isFullscreen: true }).playbackAllowed).toBe(false);
        expect(resolveMediaPlaybackActivity({ ...foreground, platform: 'android', destinationFocused: false, hostVisible: false, isFullscreen: true }).playbackAllowed).toBe(false);
    });
});
