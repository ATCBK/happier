import { describe, expect, it } from 'vitest';
import { getAllAgentCatalogDefinitions } from '@happier-dev/agents';
import { buildAgentUniverseBackendTargetKey, listAgentUniverseIds, listExecutableAgentUniverseIds } from './agentUniverse';
import { ACCOUNT_BACKEND_SETTING_ANALYTICS } from '@/sync/domains/settings/registry/account/accountBackendSettingDefinitions';
import { ACCOUNT_PERMISSION_SETTING_ANALYTICS } from '@/sync/domains/settings/registry/account/accountPermissionSettingDefinitions';

describe('agentUniverse', () => {
    it('canonicalizes a bundled Agent id to its qualified Agent target', () => {
        expect(buildAgentUniverseBackendTargetKey('antigravity'))
            .toBe('agent:happier.agent.antigravity/antigravity');
    });

    it('preserves declaration inventory while omitting abstract contributions from executable ids', () => {
        expect(listAgentUniverseIds()).toEqual(getAllAgentCatalogDefinitions().map(({ id }) => id));
        expect(listAgentUniverseIds()).toContain('custom-acp');
        const executableIds = listExecutableAgentUniverseIds();
        expect(executableIds).toContain('claude');
        expect(executableIds).not.toContain('custom-acp');
        expect(executableIds.map(buildAgentUniverseBackendTargetKey)).toContain('agent:happier.agent.claude/claude');
    });

    it('serializes executable backend preferences without a key for the abstract container', () => {
        const serializers = [ACCOUNT_BACKEND_SETTING_ANALYTICS.backendEnabledByTargetKey.serializeCurrentProperties,
            ACCOUNT_BACKEND_SETTING_ANALYTICS.backendCliSourcePreferenceByTargetKey.serializeCurrentProperties,
            ACCOUNT_PERMISSION_SETTING_ANALYTICS.sessionDefaultPermissionModeByTargetKey.serializeCurrentProperties];
        for (const serialize of serializers) {
            const properties = serialize({});
            expect(Object.keys(properties)).toContain('agent:happier.agent.claude/claude');
            expect(Object.keys(properties)).not.toContain('agent:happier.agent.custom-acp/custom-acp');
        }
    });
});
