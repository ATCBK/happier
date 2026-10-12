import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from '@happier-dev/protocol/providers/settings/v1';
import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol/providers/model-selection';

import { resolveAgentModelsSettingsAccess } from './resolveAgentModelsSettingsAccess';

describe('resolveAgentModelsSettingsAccess', () => {
    it('requires an authoritative complete row before permitting model effects', () => {
        const { defaultsByAgentTargetKey: _defaults, ...catalog } = DEFAULT_PROVIDER_SETTINGS_V1;
        expect(resolveAgentModelsSettingsAccess(null)).toMatchObject({ readable: false, writable: false });
        expect(resolveAgentModelsSettingsAccess({ status: 'loading', data: null })).toMatchObject({ readable: false, writable: false });
        expect(resolveAgentModelsSettingsAccess({ status: 'ready', data: null })).toMatchObject({ writable: false });
        expect(resolveAgentModelsSettingsAccess({ status: 'ready', data: catalog })).toMatchObject({ readable: true, writable: true });
    });

    it('retains stale visibility for display while refusing effects on incomplete catalogs', () => {
        const { defaultsByAgentTargetKey: _defaults, ...catalog } = DEFAULT_PROVIDER_SETTINGS_V1;
        const modelVisibilityByRef = { [serializeModelVisibilityRefV1({ scope: 'agent', agentTargetKey: 'agent:claude',
            providerConnectionId: null, modelId: 'retained' })]: 'hidden' as const };
        for (const status of ['loading', 'partial', 'unavailable'] as const) {
            expect(resolveAgentModelsSettingsAccess({ status, data: { ...catalog, modelVisibilityByRef } }))
                .toEqual({ readable: true, writable: false });
        }
        // Security/mode/invalid-content failures withdraw data at the catalog owner.
        expect(resolveAgentModelsSettingsAccess({ status: 'unavailable', data: null }))
            .toMatchObject({ readable: false, writable: false });
    });
});
