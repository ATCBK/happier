import * as React from 'react';

import { CapabilityScopeSection } from '@/components/capabilities/scope/CapabilityScopeSection';
import { t } from '@/text';

/**
 * "Skills and MCP servers" on the machine Overview (P8 U8.6, lab xs-M): what sessions on this machine get, with a
 * switch per row that sets a rule for this machine only. The Overview keeps its composition; this is its slot
 * before "This machine".
 */
export const MachineCapabilitiesSection = React.memo(function MachineCapabilitiesSection(props: Readonly<{
    machineId: string;
    machineName: string;
    /** The machine page already says this machine is offline (its Overview banner). */
    offline?: boolean;
}>) {
    const place = React.useMemo(() => ({ t: 'machine' as const, machineId: props.machineId }), [props.machineId]);
    return (
        <CapabilityScopeSection
            testID="machine-page-capabilities"
            place={place}
            placeLabel={props.machineName}
            description={t('capabilities.scopeSection.descMachine', { machine: props.machineName })}
            offlineStatedAbove={props.offline === true}
        />
    );
});
