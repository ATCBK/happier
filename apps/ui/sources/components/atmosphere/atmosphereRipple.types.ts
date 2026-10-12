import type { AtmosphereRgb } from '@happier-dev/brand/atmosphere';

/** One instant of the ring: the brand's normalized progress from its origin (css px), or none. */
export type AtmosphereRippleRing = Readonly<{ progress: number; x: number; y: number }> | null;
export type AtmosphereRippleHandle = Readonly<{ paint(ring: AtmosphereRippleRing): void }>;
export type AtmosphereRippleProps = Readonly<{
    /** The planet's box (css px): the ring shares it and Home's crop. */
    width: number;
    height: number;
    theme: 'light' | 'dark';
    page: AtmosphereRgb;
}>;
