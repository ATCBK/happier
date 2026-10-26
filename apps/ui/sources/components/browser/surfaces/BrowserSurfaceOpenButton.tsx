import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import type { BrowserSurfaceUnavailableReason } from '@/components/browser/surfaces/BrowserSurfaceFallback';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { t } from '@/text';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';

function decisionEnabled(decision: ReturnType<typeof useFeatureDecision>): boolean {
    return decision?.state === 'enabled';
}

/**
 * The disabled reason is expressed in the canonical surface-state vocabulary
 * ({@link BrowserSurfaceUnavailableReason}) so the accessibility hint resolves through the ONE
 * owner-copy mapper ({@link resolveReasonCopy}) — never by interpolating a raw internal code into
 * user-facing/accessibility text.
 */
function resolveDisabledReason(params: Readonly<{
    browserEnabled: boolean;
    viewTargetsEnabled: boolean;
}>): Extract<BrowserSurfaceUnavailableReason, 'disabled' | 'view_targets_disabled'> | null {
    if (!params.browserEnabled) return 'disabled';
    if (!params.viewTargetsEnabled) return 'view_targets_disabled';
    return null;
}

/**
 * Opens the browser's launchpad in Details. The canonical `IconButton` (plain), so it has the
 * tooltip, hover, pressed and keyboard focus ring every neighbouring header action has, and its
 * disabled state says why (H-UX F-7). Callers choose only the size of their row and, in coloured
 * chrome, the glyph colour.
 */
export function BrowserSurfaceOpenButton(props: Readonly<{
    onPress: () => void;
    testID: string;
    size: number;
    /** The chrome's own glyph colour (the session header); omitted, the button's default tint. */
    iconColor?: string;
    /** Horizontal gap the caller's row leaves to the neighbouring actions; the hit area reaches half of it. */
    interactiveTargetGapPx?: number;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const browserDecision = useFeatureDecision('browser', { scopeKind: 'runtime' });
    const viewTargetsDecision = useFeatureDecision('browser.viewTargets', { scopeKind: 'runtime' });
    const disabledReason = resolveDisabledReason({
        browserEnabled: decisionEnabled(browserDecision),
        viewTargetsEnabled: decisionEnabled(viewTargetsDecision),
    });
    const disabled = disabledReason !== null;
    const label = disabled ? t('browserSurface.openDisabledA11y') : t('browserSurface.openA11y');
    const glyphProps = props.iconColor
        ? { icon: <Icon name="globe" size={ICON_SIZE.sm} color={disabled ? theme.colors.text.disabled : props.iconColor} /> }
        : { iconName: 'globe' as const, iconSize: ICON_SIZE.sm };

    return (
        <IconButton
            testID={props.testID}
            variant="plain"
            size={props.size}
            interactiveTargetGapPx={props.interactiveTargetGapPx}
            accessibilityLabel={label}
            tooltip={t('browserSurface.openHint')}
            disabled={disabled}
            disabledReason={disabled && disabledReason
                ? resolveReasonCopy({ reasonCode: disabledReason, kind: 'browserSurface' }).message
                : undefined}
            onPress={props.onPress}
            {...glyphProps}
        />
    );
}
