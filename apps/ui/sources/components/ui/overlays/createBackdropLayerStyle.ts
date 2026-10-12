import { type ViewStyle } from 'react-native';
import type { CSSProperties } from 'react';
import type { GlassSurfaceGroup } from '@/components/ui/glass/glassMaterial';

export function createBackdropWebStyle(params: Readonly<{
    backgroundColor: string;
    blurPx?: number;
    enableBlur?: boolean;
    fallbackBackgroundColorWhenBlurDisabled?: string;
    surfaceGroup?: GlassSurfaceGroup;
    /** Static tone resolved by the material owner; scrims do not acquire it implicitly. */
    backdropTone?: string;
}>): CSSProperties {
    if (params.enableBlur === false) {
        return {
            backgroundColor: params.fallbackBackgroundColorWhenBlurDisabled ?? params.backgroundColor,
        };
    }

    const blurPx = typeof params.blurPx === 'number' ? params.blurPx : 12;
    // A material surface takes its group's live blur. A scrim (no group) keeps its own radius and only
    // follows floating glass being switched off: the strong floating blur belongs to the popover, and
    // a scrim inheriting it would blur the whole page behind every menu and dialog.
    const radius = params.surfaceGroup
        ? `var(--happier-glass-${params.surfaceGroup}-blur, ${blurPx}px)`
        : `min(var(--happier-glass-floating-blur, ${blurPx}px), ${blurPx}px)`;
    const filter = [`blur(${radius})`, params.backdropTone].filter(Boolean).join(' ');
    return {
        WebkitBackdropFilter: filter,
        backdropFilter: filter,
        backgroundColor: params.backgroundColor,
    };
}

export function createBackdropNativeStyle(params: Readonly<{
    backgroundColor: string;
}>): ViewStyle {
    return {
        backgroundColor: params.backgroundColor,
    };
}
