export type FileAudioPlaybackState = Readonly<{
    status: 'loading' | 'ready' | 'error';
    playing: boolean;
    currentTime: number;
    duration: number;
    error: string | null;
}>;

export type FileAudioPlayerController = FileAudioPlaybackState & Readonly<{
    playbackAllowed: boolean;
    play: () => Promise<void>;
    pause: () => void;
    seekTo: (seconds: number) => Promise<void>;
    seekBy: (seconds: number) => Promise<void>;
}>;

export const INITIAL_FILE_AUDIO_STATE: FileAudioPlaybackState = Object.freeze({
    status: 'loading', playing: false, currentTime: 0, duration: 0, error: null,
});

export function clampFileAudioSeek(seconds: number, duration: number): number {
    if (!Number.isFinite(seconds) || !Number.isFinite(duration) || duration <= 0) return 0;
    return Math.max(0, Math.min(duration, seconds));
}
