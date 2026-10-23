import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { PhoneAskSheetSpecimen, type PhoneAskSheetSpecimenPhase } from '@/components/dev/askSheet/PhoneAskSheetSpecimen';

const PHASES: readonly PhoneAskSheetSpecimenPhase[] = ['page', 'open', 'working', 'needsYou'];

/** Dev-only: the phone Ask sheet over a File page (lab ask Ap/Ap2). `?session=<id>&serverId=<id>&phase=page|open|working|needsYou`. */
export default function AskSheetDevScreen() {
    const params = useLocalSearchParams<{ session?: string; serverId?: string; phase?: string }>();
    const phase = PHASES.find((candidate) => candidate === params.phase) ?? 'page';
    return <PhoneAskSheetSpecimen sessionId={params.session ?? ''} serverId={params.serverId ?? ''} phase={phase} />;
}
