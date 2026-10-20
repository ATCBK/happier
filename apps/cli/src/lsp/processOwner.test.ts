import { expect, it } from 'vitest';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { createLanguageServerDefinitions } from './languageServerDefinitions';
import { serviceOwnerDisplayName, serviceOwnerRole } from './processOwner';

it('uses service ownership for the role and the exact server definition for its display name', () => {
    const registry = createResolvedContributionRegistry({ languageServers: [{ provenance: 'external', source: { kind: 'path' },
        pluginId: 'com.example.lang', identity: { pluginId: 'com.example.lang', localId: 'server' }, manifestPath: '/plugins/lang/plugin.json',
        definition: { id: 'server', title: 'Example language', languageIds: { example: 'example' },
            executable: { kind: 'systemTool', id: 'server' }, args: ['--stdio'] } }] });
    const definitions = createLanguageServerDefinitions({ readCurrentContributionRegistry: () => registry }).readLanguageServerDefinitions();
    const owner = { kind: 'service' as const, serviceId: 'lsp:com.example.lang/server:0123456789ab' };
    expect(serviceOwnerRole(owner)).toBe('language_server');
    expect(serviceOwnerDisplayName(owner, definitions)).toBe('Example language');
    expect(serviceOwnerDisplayName({ ...owner, serviceId: 'lsp:com.example.lang/server-extra:0123456789ab' }, definitions)).toBeUndefined();
    expect(serviceOwnerRole({ kind: 'service', serviceId: 'another:com.example.lang/server' })).toBeUndefined();
    expect(serviceOwnerRole({ kind: 'session', sessionId: owner.serviceId })).toBeUndefined();
    expect(serviceOwnerRole(null)).toBeUndefined();
});
