import { describe, expect, it } from 'vitest';

import { sanitizeNewSessionConfigOverridesForModelSelection } from './newSessionConfigOptionOverrideSanitization';

describe('sanitizeNewSessionConfigOverridesForModelSelection', () => {
    it('validates source-model intent against its descriptor when a native model has the same id', () => {
        const option = (value: string) => ({ id: 'reasoning_effort', name: 'Thinking', type: 'select',
            currentValue: value, options: [{ value, name: value }] });
        const input = { providerId: 'codex', configOptions: [],
            modelOptions: [{ value: 'shared-model', modelOptions: [option('high')] }],
            selectedModelId: 'shared-model', selectedModelConfigOptions: [option('max')] };
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input,
            selectedConfigOverrides: { reasoning_effort: 'max' } })).toEqual({ reasoning_effort: 'max' });
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input,
            selectedConfigOverrides: { reasoning_effort: 'high' } })).toEqual({});
        expect(sanitizeNewSessionConfigOverridesForModelSelection({ ...input,
            selectedModelConfigOptions: [], selectedConfigOverrides: { reasoning_effort: 'high' } })).toEqual({});
    });
    it('preserves base model scoped overrides when the selected model is its declared extended-context variant', () => {
        expect(sanitizeNewSessionConfigOverridesForModelSelection({
            providerId: 'claude',
            configOptions: [],
            modelOptions: [{
                value: 'claude-sonnet-4-6',
                extendedContextModelId: 'claude-sonnet-4-6[1m]',
                modelOptions: [{
                    id: 'reasoning_effort',
                    name: 'Reasoning effort',
                    type: 'select',
                    currentValue: 'medium',
                    options: [
                        { value: 'medium', name: 'Medium' },
                        { value: 'high', name: 'High' },
                    ],
                }],
            }],
            selectedModelId: 'claude-sonnet-4-6[1m]',
            selectedConfigOverrides: {
                reasoning_effort: 'high',
            },
        })).toEqual({
            reasoning_effort: 'high',
        });
    });
});
