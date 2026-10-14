import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { SkillsFoundSpecimen } from '@/components/dev/capabilities/SkillsFoundSpecimen';

/** Dev-only (P6 U6.5 intermediate, deleted at landing): the Found page in states the QA Account cannot reach. */
export default function SkillsFoundDevScreen() {
  const params = useLocalSearchParams<{ state?: string }>();
  return <SkillsFoundSpecimen state={params.state} />;
}
