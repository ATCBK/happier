import * as React from 'react';

import type { AgentInputStatusBadge } from '@/components/sessions/agentInput/agentInputContracts';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { buildRequesterDisclosureStatusBadge, type RequesterDisclosureModel } from '@/components/machines/managed/managedComposerBadges';

type NewSessionLaunchStatusBadgeParams = Readonly<{
    isCreating: boolean;
    disabledReason?: string | null;
    requesterDisclosure?: RequesterDisclosureModel;
    translate: (key: 'newSession.startingSession') => string;
}>;

export function buildNewSessionLaunchStatusBadges(
    params: NewSessionLaunchStatusBadgeParams,
): ReadonlyArray<AgentInputStatusBadge> {
    const disclosure: ReadonlyArray<AgentInputStatusBadge> = params.requesterDisclosure
        ? [buildRequesterDisclosureStatusBadge(params.requesterDisclosure)] : [];
    if (!params.isCreating) {
        return params.disabledReason ? [...disclosure, {
            key: 'new-session-create-blocked',
            label: params.disabledReason,
            labelNumberOfLines: 0,
            accessibilityLabel: params.disabledReason,
            testID: 'new-session-create-blocked',
            tone: 'warning',
            emphasis: 'prominent',
            // Every composer badge leads with its state mark (lab `.l12-sb`); a blocked launch takes the
            // same warning glyph as every other warning badge in the strip (a failed machine install).
            icon: (tint) => React.createElement(Icon, { name: 'warning', size: 14, color: tint }),
        }] : disclosure;
    }

    const label = params.translate('newSession.startingSession');
    return [...disclosure, {
        key: 'new-session-launch-starting',
        label,
        accessibilityLabel: label,
        testID: 'new-session-launch-status',
        // Work in progress needs nothing from the user, so it stays quiet: the neutral badge with a
        // spinner as its mark (lab `m-pick-Aprog`), the same as a machine that is still being set up.
        tone: 'neutral',
        emphasis: 'prominent',
        icon: (tint) => React.createElement(ActivitySpinner, {
            size: 'small', color: tint, accessibilityElementsHidden: true, importantForAccessibility: 'no',
        }),
    }];
}
