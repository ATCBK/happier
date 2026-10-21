import { describe, expect, it } from 'vitest';

import { getNeutralAgentIdentityColor, readBundledAgentPresentation } from './presentation.js';

describe('bundled Agent presentation', () => {
    it('reads exact declared names and descriptor hues without activating an Agent', () => {
        expect(readBundledAgentPresentation('claude')).toEqual({
            name: 'Claude',
            identityColor: { light: '#eb6834', dark: '#d95926' },
        });
        expect(readBundledAgentPresentation('codex')).toEqual({
            name: 'Codex',
            identityColor: { light: '#2a78d6', dark: '#3987e5' },
        });
        expect(readBundledAgentPresentation('acme/assistant')).toBeNull();
        expect(readBundledAgentPresentation('__proto__')).toBeNull();
        expect(readBundledAgentPresentation('qwen')).toEqual({ name: 'Qwen Code', identityColor: null });
        expect(getNeutralAgentIdentityColor({ dark: false })).toBe('#A3A3A8');
        expect(getNeutralAgentIdentityColor({ dark: true })).toBe('#6C625D');
    });
});
