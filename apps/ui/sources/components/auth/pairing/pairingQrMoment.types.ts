export type PairingQrMomentCanvasProps = Readonly<{
    /** The code block's outer size in css px (the paper). */
    size: number;
    theme: 'light' | 'dark';
    reducedMotion: boolean;
    /** The pairing moment's own switch: off, a scan rests on the planet. */
    pairing: boolean;
    /** Display names of the Home's machines; the first two stand on the horizon beside the new one. */
    machines: readonly string[];
}>;
