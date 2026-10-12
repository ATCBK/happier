import * as React from 'react';

import { AllMachinesIndex } from '@/components/machines/index/AllMachinesIndex';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

/**
 * `/settings/machines`: All machines, the same index as the rail door's `/machines` (MPG-4). Beside
 * the list it is the selected first row's page; where no list shows, it is followed by the
 * collection's configuration groups. Nothing renders before the first measurement, so neither flashes.
 */
export const MachineSettingsIndex = React.memo(function MachineSettingsIndex() {
    const view = useHappierCollectionIndexView();
    if (view === 'pending') return null;
    return <AllMachinesIndex />;
});
