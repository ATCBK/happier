import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { SkillsHomeSpecimen } from '@/components/dev/capabilities/SkillsHomeSpecimen';

/** Dev-only (P6 U6.2 intermediate, deleted at landing): the Skills homepage's empty, error and first-visit states. */
export default function SkillsHomeDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    return <SkillsHomeSpecimen state={params.state} />;
}
