import * as React from 'react';

import { MachineFreshnessChip } from '@/components/machines/page/MachineFreshnessChip';
import type { MachinePageTabBarAccessoryProps } from '@/components/machines/page/machinePageTabQuery';

import { useGuardFreshness } from './useGuardFreshness';

/** The Guard tab's freshness chip at the end of the page's tab bar on wide layouts (phones keep it in the body). */
export const GuardBarAccessory = React.memo(function GuardBarAccessory(props: MachinePageTabBarAccessoryProps) {
    // Activity owns range/filter locally and presents that query's freshness beside its title.
    if (props.params?.id === 'guard' && props.params.page === 'activity') return null;
    return <GuardFreshnessAccessory {...props} />;
});

function GuardFreshnessAccessory(props: MachinePageTabBarAccessoryProps) {
    const freshness = useGuardFreshness(props);
    return <MachineFreshnessChip testID={`machine-guard-${freshness.kind}`} freshness={freshness} />;
}

/** Where the page has no tab-bar end for it (a phone), the chip is the line under the tab's purpose sentence. */
export function GuardPhoneFreshness(props: Readonly<{ serverId: string; machineId: string }>) {
    const freshness = useGuardFreshness(props);
    if (freshness.kind === 'none') return null;
    return <MachineFreshnessChip testID={`machine-guard-${freshness.kind}`} freshness={freshness} />;
}
