import * as React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

// Native, font/theme and icon adapters are the platform boundaries; the composer's control placement is real.
installAgentInputCommonModuleMocks();
vi.mock('expo-image', () => ({ Image: () => null }));
vi.mock('expo-crypto', async () => ({
    ...await import('@/platform/cryptoRandom.node'),
    ...await import('@/platform/randomUUID.node'),
}));

beforeAll(async () => { await import('./AgentInput'); }, 600_000);

describe('AgentInput fixed engine', () => {
    // A question to a walkthrough is answered by the Run that wrote it: the composer names that model and
    // offers no picker, because nothing chosen here would change who answers.
    it('names a fixed engine without a picker when engine controls are off', async () => {
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(<AgentInput value="" placeholder="Reply to Walkthrough…" onChangeText={() => undefined}
            onSend={() => undefined} autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            voiceAffordance="none" engineControls="none" engineLabel="GPT-6-Luna" engineAgentId="codex" />);
        const chip = screen.findHostByTestId('agent-input-agent-chip');
        expect(chip, 'the fixed engine is named').not.toBeNull();
        expect(chip?.props.accessibilityLabel ?? chip?.props['aria-label']).toBe('GPT-6-Luna');
        expect(chip?.props.accessibilityState?.disabled ?? chip?.props['aria-disabled']).toBe(true);
    });

    it('draws no engine chip when engine controls are off and nothing names the engine', async () => {
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(<AgentInput value="" placeholder="Message" onChangeText={() => undefined}
            onSend={() => undefined} autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            voiceAffordance="none" engineControls="none" />);
        expect(screen.findHostByTestId('agent-input-agent-chip')).toBeNull();
    });
});
