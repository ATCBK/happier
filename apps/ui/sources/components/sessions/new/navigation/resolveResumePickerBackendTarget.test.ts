import { describe, expect, it } from 'vitest';

import { resolveResumePickerBackendTarget } from './resolveResumePickerBackendTarget';

describe('resolveResumePickerBackendTarget', () => {
    it('retains an explicit configured selection for repair when its catalog row is missing', () => {
        expect(resolveResumePickerBackendTarget({
            tempBackendTarget: { kind: 'backend', backendId: 'missing-review-bot', configuredBackendId: 'missing-review-bot' },
            routeBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            availableBackendTargets: [
                { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' },
            ],
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'claude' },
        })).toEqual({ kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'missing-review-bot' });
    });

    it('uses the route selection before the settings default when no temporary choice was made', () => {
        expect(resolveResumePickerBackendTarget({
            routeBackendTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' },
            availableBackendTargets: [{ kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' }],
            lastUsedAgent: 'claude',
        })).toEqual({ kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' }, definitionId: 'review-bot' });
    });
});
