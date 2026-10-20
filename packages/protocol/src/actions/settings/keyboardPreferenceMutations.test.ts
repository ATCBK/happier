import { describe, expect, it } from 'vitest';
import { parseKeybindingRule } from './keyboardPreferenceMutations';

describe('physical punctuation bindings', () => {
    it('represents a shifted plus without confusing the chord separator with the key', () => {
        expect(parseKeybindingRule('Shift+=')).toMatchObject({ code: 'Equal', shift: true });
        expect(parseKeybindingRule('NumpadAdd')).toMatchObject({ code: 'NumpadAdd' });
    });
});
