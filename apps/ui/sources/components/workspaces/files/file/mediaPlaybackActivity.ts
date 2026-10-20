export function resolveMediaPlaybackActivity(input: Readonly<{
    isActive: boolean;
    destinationFocused: boolean;
    hostVisible: boolean;
    isFullscreen: boolean;
    platform: string;
    voiceOutputActive: boolean;
}>): Readonly<{ enabled: boolean; playbackAllowed: boolean }> {
    // Android opens fullscreen video in its own Activity, which backgrounds the React host.
    const enabled = input.isActive && input.destinationFocused
        && (input.hostVisible || input.platform === 'android' && input.isFullscreen);
    return { enabled, playbackAllowed: enabled && !input.voiceOutputActive };
}
