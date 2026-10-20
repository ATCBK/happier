import * as React from 'react';
import { Platform } from 'react-native';

import { useDestinationFocus } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useHostActivelyViewed } from '@/utils/runtime/useHostActivelyViewed';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';

import { resolveMediaPlaybackActivity } from './mediaPlaybackActivity';

function readVoiceOutputActive(): boolean {
    return voiceRuntimeLevelStore.getSourceActivitySnapshot().outputSourceActive;
}

function subscribeVoiceOutputActive(listener: () => void): () => void {
    return voiceRuntimeLevelStore.subscribeSourceActivity(listener);
}

/** Source admission and player pausing share the existing destination, host, and voice facts. */
export function useMediaPlaybackLifecycle(input: Readonly<{
    isActive: boolean;
    isFullscreen: boolean;
    pause: () => void;
}>) {
    const destinationFocused = useDestinationFocus();
    const hostVisible = useHostActivelyViewed();
    const voiceOutputActive = React.useSyncExternalStore(subscribeVoiceOutputActive, readVoiceOutputActive, () => false);
    const { enabled, playbackAllowed } = resolveMediaPlaybackActivity({
        isActive: input.isActive,
        destinationFocused,
        hostVisible,
        isFullscreen: input.isFullscreen,
        platform: Platform.OS,
        voiceOutputActive,
    });
    const { pause } = input;
    React.useEffect(() => {
        if (!playbackAllowed) pause();
    }, [playbackAllowed, pause]);
    React.useLayoutEffect(() => () => pause(), [pause]);
    return { enabled, playbackAllowed, voiceOutputActive };
}
