import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { CapabilityAddSpecimen } from '@/components/dev/capabilities/CapabilityAddSpecimen';

/** Dev-only (P5 U5.1 prototype, deleted at landing): the capability add modal with the lab cast. `?open=1` opens it. */
export default function CapabilityAddDevScreen() {
    const params = useLocalSearchParams<{ open?: string }>();
    return <CapabilityAddSpecimen openOnArrival={params.open === '1'} />;
}
