import * as React from 'react';

import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { t } from '@/text';

/**
 * What a suspended member sees in place of the Team: their access is paused by its admins and
 * leaving is theirs to choose. It states the state; the Leave action sits right below it, and no
 * other action is offered. Neutral, because nothing here is a failure and nothing is waiting on them.
 */
export const TeamSuspendedNotice = React.memo(function TeamSuspendedNotice() {
    return (
        <AttentionBanner
            testID="team-overview-suspended"
            tone="neutral"
            title={t('teams.overview.suspendedTitle')}
            description={t('teams.overview.suspendedBody')}
        />
    );
});
