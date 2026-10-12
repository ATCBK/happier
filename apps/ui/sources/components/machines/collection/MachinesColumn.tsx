import * as React from 'react';

import { MachinesDoorProvider } from '@/components/machines/page/machinesDoor';
import { MachineCollectionRail } from '@/components/settings/machines/collection/MachineCollectionList';

/**
 * The rail door's column (R1): the same machine list the Settings door shows beside the Settings column,
 * standing where the Settings column would. Every row it renders links inside the rail door.
 */
export const MachinesColumn = React.memo(function MachinesColumn() {
    return (
        <MachinesDoorProvider door="rail">
            <MachineCollectionRail />
        </MachinesDoorProvider>
    );
});
