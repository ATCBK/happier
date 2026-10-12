import { describe, expect, it } from 'vitest';
import { normalizeSessionAuthoringConnectedServices, normalizeSessionAuthoringTerminal } from './sessionAuthoringNormalization';

describe('stored Session authoring normalization', () => {
    it('projects retained terminal fields recursively and still rejects invalid known fields', () => {
        expect(normalizeSessionAuthoringTerminal({ mode: 'tmux', retired: true,
            tmux: { sessionName: 'work', retired: true } })).toEqual({ mode: 'tmux', tmux: { sessionName: 'work' } });
        expect(normalizeSessionAuthoringTerminal({ mode: 'tmux', tmux: { sessionName: 3 } })).toBeNull();
    });

    it('preserves the canonical opaque connected-services JSON carrier', () => {
        const value = { v: 2, retainedExtension: { value: true }, bindingsByServiceId: {} };
        expect(normalizeSessionAuthoringConnectedServices(value)).toEqual(value);
    });
});
