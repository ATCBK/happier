import * as React from 'react';

import { clampFileAudioSeek, INITIAL_FILE_AUDIO_STATE, type FileAudioPlaybackState, type FileAudioPlayerController } from './fileAudioPlayback';
import { useMediaPlaybackLifecycle } from './useMediaPlaybackLifecycle';

/** A local preview URI is borrowed from the preview-source owner and is never revoked here. */
export function useFileAudioPlayer(input: Readonly<{ uri: string; isActive: boolean }>): FileAudioPlayerController {
    const audioRef = React.useRef<HTMLAudioElement | null>(null);
    const [snapshot, setSnapshot] = React.useState<Readonly<{ uri: string; state: FileAudioPlaybackState }> | null>(null);
    const pause = React.useCallback(() => { audioRef.current?.pause(); }, []);
    const { playbackAllowed } = useMediaPlaybackLifecycle({ isActive: input.isActive, isFullscreen: false, pause });
    const allowedRef = React.useRef(playbackAllowed);
    allowedRef.current = playbackAllowed;
    const { uri } = input;

    React.useEffect(() => {
        let audio: HTMLAudioElement;
        try {
            audio = new Audio(uri);
        } catch (error) {
            setSnapshot({ uri, state: { ...INITIAL_FILE_AUDIO_STATE, status: 'error', error: error instanceof Error ? error.message : String(error) } });
            return;
        }
        audio.preload = 'metadata';
        audioRef.current = audio;
        const publish = () => {
            if (audioRef.current !== audio) return;
            const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
            setSnapshot({ uri, state: {
                status: audio.error ? 'error' : audio.readyState > 0 ? 'ready' : 'loading',
                playing: !audio.paused && !audio.ended,
                currentTime: clampFileAudioSeek(audio.currentTime, duration),
                duration,
                error: audio.error ? audio.error.message || `audio_decode_failed:${audio.error.code}` : null,
            } });
        };
        const events = ['loadedmetadata', 'durationchange', 'timeupdate', 'play', 'pause', 'ended', 'error'] as const;
        for (const event of events) audio.addEventListener(event, publish);
        publish();
        return () => {
            for (const event of events) audio.removeEventListener(event, publish);
            if (audioRef.current === audio) audioRef.current = null;
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        };
    }, [uri]);

    const play = React.useCallback(async () => {
        const audio = audioRef.current;
        if (!audio || !allowedRef.current) return;
        try {
            await audio.play();
        } catch (error) {
            if (audioRef.current !== audio) return;
            if (!allowedRef.current || error instanceof Error && error.name === 'AbortError' && audio.paused) return;
            setSnapshot(previous => ({ uri, state: {
                ...(previous?.uri === uri ? previous.state : INITIAL_FILE_AUDIO_STATE),
                status: 'error', playing: false, error: error instanceof Error ? error.message : String(error),
            } }));
        }
    }, [uri]);
    const seekTo = React.useCallback(async (seconds: number) => {
        const audio = audioRef.current;
        if (!audio) return;
        audio.currentTime = clampFileAudioSeek(seconds, audio.duration);
    }, []);
    const seekBy = React.useCallback(async (seconds: number) => {
        const audio = audioRef.current;
        if (audio) await seekTo(audio.currentTime + seconds);
    }, [seekTo]);
    const state = snapshot?.uri === uri ? snapshot.state : INITIAL_FILE_AUDIO_STATE;
    return { ...state, playbackAllowed, play, pause, seekTo, seekBy };
}
