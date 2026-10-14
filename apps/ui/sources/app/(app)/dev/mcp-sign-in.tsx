import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { McpSignInSpecimen } from '@/components/dev/capabilities/McpSignInSpecimen';

/** Dev-only: every MCP Sign-in state (lab ms-B) through the real section. `?state=signing|connected|…`. */
export default function McpSignInDevScreen() {
    const params = useLocalSearchParams<{ state?: string }>();
    return <McpSignInSpecimen state={typeof params.state === 'string' ? params.state : undefined} />;
}
