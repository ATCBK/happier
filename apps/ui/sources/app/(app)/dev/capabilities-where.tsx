import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { WhereItsOnSpecimen } from '@/components/dev/capabilities/WhereItsOnSpecimen';

/** Dev-only (P5 U5.3 intermediate, deleted at landing): "Where it's on" with the lab cast. */
export default function WhereItsOnDevScreen() {
    const params = useLocalSearchParams<{ scene?: string; fail?: string; readonly?: string }>();
    return <WhereItsOnSpecimen scene={params.scene} fail={params.fail === '1'} readOnly={params.readonly === '1'} />;
}
