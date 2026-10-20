import { describe, expect, it } from 'vitest';
import { CUA_PLUGIN } from '../manifest.js';
import { ByocProvisionerSchemas } from './remoteProvisionerSchemas.js';
import * as stored from './remoteProvisionerSchemas.js';

describe('Cua remote provisioner public author contract', () => {
    it('declares the native query fields for a fresh BYOC configuration', () => {
        const options = CUA_PLUGIN.manifest.contributes.actions?.find(action => action.id === 'byoc-options');
        expect(options?.inputHints?.fields.filter(field => field.required).map(field => field.path))
            .toEqual(expect.arrayContaining(['cloud']));
    });
    it('keeps native resource ingress strict and preserves the admitted resource in canonical acquire output', () => {
        const byoc = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: 'aws:owned', ownedAttachmentIds: [] };
        expect(ByocProvisionerSchemas.resourceInput.safeParse({ resource: { ...byoc, token: 'private' } }).success).toBe(false);
        expect(ByocProvisionerSchemas.acquireResult.parse({ kind: 'bound', resource: { contributionRef: { pluginId: CUA_PLUGIN.manifest.id,
            localId: 'byoc' }, schemaVersion: 1, value: byoc } })).toMatchObject({ resource: { value: byoc } });
    });

    it('reopens stored additions through the SDK reader without weakening native ingress', async () => {
        const byoc = { cloud: 'aws', nativeResourceId: 'i-owned', sandboxId: 'aws:owned', ownedAttachmentIds: [] };
        const byocReaders = await stored.prepareCuaByocStoredSchemas();
        expect(byocReaders.resourceStored.parse({ ...byoc, future: { token: 'private' } })).toEqual(byoc);
        expect(byocReaders.resourceStored.safeParse({ ...byoc, cloud: 'other' }).success).toBe(false);
    });
});
