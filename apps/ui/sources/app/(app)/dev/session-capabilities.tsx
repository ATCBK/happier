import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { SessionCapabilitiesSpecimen } from '@/components/dev/capabilities/SessionCapabilitiesSpecimen';

/** Dev-only (P8 U8.3 shell first, deleted when Lane 12 Main mounts the chip): "This session gets" with the lab cast. */
export default function SessionCapabilitiesDevScreen() {
    const params = useLocalSearchParams<{ scene?: string }>();
    return <SessionCapabilitiesSpecimen key={params.scene ?? 'new'} scene={params.scene} />;
}
