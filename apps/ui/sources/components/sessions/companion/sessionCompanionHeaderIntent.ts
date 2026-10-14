import { t } from '@/text';

import type { SessionCompanionPlacement } from './layout/resolveSessionCompanionPlacement';
import type { SessionCompanionPreferenceV1 } from './state/sessionCompanionPreference';
import { resolveSessionCompanionItemCount } from './state/sessionCompanionPreference';

export type SessionCompanionHeaderOperation =
    | 'show'
    | 'hide'
    | 'expand'
    | 'open_full'
    | 'show_and_open_full';

export type SessionCompanionHeaderAccessibility =
    | 'show'
    | 'hide'
    | 'expand'
    | 'open_full';

export type SessionCompanionHeaderIntent = Readonly<{
    operation: SessionCompanionHeaderOperation;
    accessibility: SessionCompanionHeaderAccessibility;
    itemCount: number;
    /** Content is on screen in the reserved rail, not merely selected locally. */
    expanded: boolean;
    /** Overflow preserves the viewer-local selected state independently of its action. */
    checked: boolean;
}>;

type SessionCompanionHeaderIntentInput = Readonly<{
    visible: boolean;
    itemCount: number;
    placement: SessionCompanionPlacement;
    isPhone?: boolean;
}>;

/**
 * One semantic owner for both presentations of the Companion header action.
 * Placement changes only where the action is rendered; it must never change
 * what selecting that action does or what its accessibility state reports.
 */
export function resolveSessionCompanionHeaderIntent(
    input: SessionCompanionHeaderIntentInput,
): SessionCompanionHeaderIntent {
    const itemCount = resolveSessionCompanionItemCount(input);
    if (!input.visible) {
        const operation = input.isPhone ? 'show_and_open_full' : 'show';
        return {
            operation,
            accessibility: input.isPhone ? 'open_full' : 'show',
            itemCount,
            expanded: false,
            checked: false,
        };
    }

    if (input.isPhone) {
        return {
            operation: 'open_full',
            accessibility: 'open_full',
            itemCount,
            expanded: false,
            checked: true,
        };
    }

    if (input.placement.kind === 'reserved_rail') {
        return {
            operation: 'hide',
            accessibility: 'hide',
            itemCount,
            expanded: true,
            checked: true,
        };
    }

    if (input.placement.kind === 'measuring_rail'
        || input.placement.kind === 'collapsed_control' && input.placement.reason === 'preference') {
        return {
            operation: 'expand',
            accessibility: 'expand',
            itemCount,
            expanded: false,
            checked: true,
        };
    }

    return {
        operation: 'open_full',
        accessibility: 'open_full',
        itemCount,
        expanded: false,
        checked: true,
    };
}

/**
 * Both header placements announce the same operation and visible item count.
 * Reusing the existing localized action and count phrases avoids a second
 * presentation-specific vocabulary while keeping the action truthful.
 */
export function resolveSessionCompanionHeaderAccessibilityLabel(
    intent: SessionCompanionHeaderIntent,
): string {
    if (intent.accessibility === 'show') {
        return t('sessionBoard.companion.a11y.show', { count: intent.itemCount });
    }
    if (intent.accessibility === 'expand') {
        return t('sessionBoard.companion.a11y.expand', { count: intent.itemCount });
    }

    const itemSummary = t('sessionBoard.companion.a11y.headerAction', {
        count: intent.itemCount,
    });
    const action = intent.accessibility === 'open_full'
        ? t('sessionBoard.companion.actions.openFull')
        : t('sessionBoard.companion.actions.hide');
    return `${action}. ${itemSummary}`;
}

/**
 * A show gesture is complete in one press: reveal the measured rail when it fits,
 * otherwise use the existing full destination. The supplied resolver is the
 * incumbent pane/measurement owner evaluated against the applied preference.
 */
export function shouldOpenFullCompanionAfterShow(input: Readonly<{
    applied: SessionCompanionPreferenceV1;
    resolvePlacement: (preference: SessionCompanionPreferenceV1) => SessionCompanionPlacement;
}>): boolean {
    const placement = input.resolvePlacement(input.applied);
    return placement.kind !== 'reserved_rail' && placement.kind !== 'measuring_rail';
}
