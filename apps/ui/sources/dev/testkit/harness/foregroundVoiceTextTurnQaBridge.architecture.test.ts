import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('foreground Voice text-turn QA bridge ownership', () => {
    it('does not import foreground context or action owners', async () => {
        const source = await readFile('sources/dev/testkit/harness/foregroundVoiceTextTurnQaBridge.ts', 'utf8');

        expect(source).not.toContain('voiceConversationBindingResolver');
        expect(source).not.toContain('@/components/appShell');
        expect(source).not.toContain('@/voice/tools');
        expect(source).not.toMatch(/currentUiContext|runVoiceAgentTurnWithTools|readCurrentUiContext/u);
    });
});
