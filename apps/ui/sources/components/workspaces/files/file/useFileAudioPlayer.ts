import * as React from 'react';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';

import { acquireVoicePlaybackAudioMode, type VoiceAudioModeLease } from '@/voice/runtime/voiceAudioMode';

import { clampFileAudioSeek, type FileAudioPlayerController } from './fileAudioPlayback';
import { useMediaPlaybackLifecycle } from './useMediaPlaybackLifecycle';

/** Native playback participates in the existing audio-session owner; it sets no Expo audio mode. */
export function useFileAudioPlayer(input: Readonly<{ uri: string; isActive: boolean }>): FileAudioPlayerController {
    const player = useAudioPlayer(input.uri, { keepAudioSessionActive: true });
    const status = useAudioPlayerStatus(player);
    const lease = React.useRef<VoiceAudioModeLease | null>(null);
    const pendingLease = React.useRef<Readonly<{ player: typeof player; promise: Promise<VoiceAudioModeLease> }> | null>(null);
    const playRequested = React.useRef(false);
    const [failure, setFailure] = React.useState<Readonly<{ playerId: string; error: string }> | null>(null);
    const pause = React.useCallback(() => {
        playRequested.current = false;
        try { player.pause(); } catch { /* The native handle may already have been released. */ }
        const previous = lease.current;
        lease.current = null;
        if (previous) void previous.release().catch(() => {});
    }, [player]);
    const { playbackAllowed } = useMediaPlaybackLifecycle({ isActive: input.isActive, isFullscreen: false, pause });
    const current = React.useRef({ player, playbackAllowed });
    current.current = { player, playbackAllowed };
    const play = React.useCallback(async () => {
        if (current.current.player !== player || !current.current.playbackAllowed) return;
        playRequested.current = true;
        let requested: Promise<VoiceAudioModeLease> | null = null;
        try {
            if (!lease.current) {
                requested = pendingLease.current?.player === player ? pendingLease.current.promise
                    : acquireVoicePlaybackAudioMode(`file-media:${player.id}`);
                pendingLease.current = { player, promise: requested };
                const acquired = await requested;
                if (pendingLease.current?.promise === requested) pendingLease.current = null;
                if (!playRequested.current || current.current.player !== player || !current.current.playbackAllowed) {
                    await acquired.release();
                    return;
                }
                lease.current = acquired;
            }
            setFailure(null);
            player.play();
        } catch (error) {
            if (pendingLease.current?.promise === requested) pendingLease.current = null;
            if (current.current.player === player) {
                setFailure({ playerId: player.id, error: error instanceof Error ? error.message : String(error) });
                pause();
            }
        }
    }, [player, pause]);
    React.useEffect(() => {
        if (status.didJustFinish || status.playbackState === 'failed') pause();
    }, [status.didJustFinish, status.playbackState, pause]);
    const seekTo = React.useCallback(async (seconds: number) => {
        await player.seekTo(clampFileAudioSeek(seconds, player.duration));
    }, [player]);
    const seekBy = React.useCallback(async (seconds: number) => {
        await seekTo(player.currentTime + seconds);
    }, [player, seekTo]);
    const error = failure?.playerId === player.id ? failure.error
        : status.playbackState === 'failed' ? 'audio_decode_failed' : null;
    return {
        status: error ? 'error' : status.isLoaded ? 'ready' : 'loading',
        playing: status.playing,
        currentTime: clampFileAudioSeek(status.currentTime, status.duration),
        duration: Number.isFinite(status.duration) && status.duration > 0 ? status.duration : 0,
        error,
        playbackAllowed,
        play,
        pause,
        seekTo,
        seekBy,
    };
}
