import { useLocalSearchParams } from 'expo-router';
import * as React from 'react';

import { McpHomeSpecimen } from '@/components/dev/capabilities/McpHomeSpecimen';

/** Dev-only: the MCP homepage moments (lab hm-A1…A4, a 13-server ring) with the lab cast. `?moment=first|att|ok|new|many`. */
export default function McpHomeDevScreen() {
    const params = useLocalSearchParams<{ moment?: string }>();
    return <McpHomeSpecimen moment={typeof params.moment === 'string' ? params.moment : 'att'} />;
}
