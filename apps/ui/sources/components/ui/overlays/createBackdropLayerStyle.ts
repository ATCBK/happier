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

/**
 * The modal scrim behind a dialog or a floating route (BaseModal, the floating New Session
 * composer): the wizard scrim under a light frost, or the strong scrim when blur is off.
 */
export function createModalScrimWebStyle(params: Readonly<{
    overlay: Readonly<{ scrim: string; scrimWizard?: string; scrimStrong?: string }>;
    enableBlur: boolean;
    /** False while the scrim is leaving: it clears to transparent. */
    visible?: boolean;
    /**
     * `scrim` (default): a light frost behind a card. `floating`: content sits directly on the scrim
     * (no card), so it takes the floating glass frost and the page behind it stops competing.
     */
    frost?: 'scrim' | 'floating';
}>): CSSProperties {
    const visible = params.visible !== false;
    return createBackdropWebStyle({
        backgroundColor: visible ? (params.overlay.scrimWizard ?? params.overlay.scrim) : 'transparent',
        blurPx: visible ? 2 : 0,
        ...(params.frost === 'floating' && visible ? { surfaceGroup: 'floating' as const } : {}),
        enableBlur: params.enableBlur && visible,
        fallbackBackgroundColorWhenBlurDisabled: visible
            ? (params.overlay.scrimStrong ?? params.overlay.scrim)
            : 'transparent',
    });
}

export function createBackdropNativeStyle(params: Readonly<{
    backgroundColor: string;
}>): ViewStyle {
    return {
        backgroundColor: params.backgroundColor,
    };
}
