import { describe, expect, it } from 'vitest';

import { describeRoleEngineChoice } from './useRoleEnginePresentation';

describe('describeRoleEngineChoice', () => {
    it('names the model and effort with the Agent catalog words, not raw ids', () => {
        expect(describeRoleEngineChoice('claude', {
            agentTargetKey: 'agent:claude', modelId: 'claude-sonnet-4-6', effort: 'low',
        })).toEqual({ model: 'Sonnet 4.6', effort: 'Low' });
    });

    it('reads the Agent from the engine key while the Agent catalog is not loaded', () => {
        expect(describeRoleEngineChoice(null, {
            agentTargetKey: 'backend:claude', modelId: 'claude-sonnet-4-6', effort: 'low',
        })).toEqual({ model: 'Sonnet 4.6', effort: 'Low' });
    });

    it('keeps an id the catalog cannot name rather than inventing one', () => {
        expect(describeRoleEngineChoice('claude', {
            agentTargetKey: 'agent:claude', modelId: 'claude-private-preview', effort: 'turbo',
        })).toEqual({ model: 'claude-private-preview', effort: 'turbo' });
        expect(describeRoleEngineChoice(null, { agentTargetKey: 'agent:unknown' })).toEqual({ model: null, effort: null });
    });
});
