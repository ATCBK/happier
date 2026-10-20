import { describe, expect, it } from 'vitest';

import { isVoiceBargeInEnabled } from './localVoiceSettings';

describe('isVoiceBargeInEnabled', () => {
    it('follows the settings schema default (on) when bargeInEnabled is unset', () => {
        const settings = { voice: { providerId: 'local_conversation', adapters: { local_conversation: { tts: {} } } } };
        expect(isVoiceBargeInEnabled(settings)).toBe(true);
    });

    it('is off only when explicitly disabled', () => {
        const settings = { voice: { providerId: 'local_conversation', adapters: { local_conversation: { tts: { bargeInEnabled: false } } } } };
        expect(isVoiceBargeInEnabled(settings)).toBe(false);
    });
});
