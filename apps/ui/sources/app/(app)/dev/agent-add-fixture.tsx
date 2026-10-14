import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { AgentAddFixtureSpecimen } from '@/components/dev/capabilities/AgentAddFixtureSpecimen';

/** Dev-only (P9 U9.4): the agent Add modal's Adding / after-add states with a lab cast. `?open=1` opens it. */
export default function AgentAddFixtureDevScreen() {
    const params = useLocalSearchParams<{ open?: string }>();
    return <AgentAddFixtureSpecimen openOnArrival={params.open === '1'} />;
}
