import { describe, expect, it } from 'vitest';

import { buildWorkspacePreviewIdentity } from './buildWorkspacePreviewIdentity';

const scope = { serverId: 'home', machineId: 'machine', rootPath: '/repo' };

describe('workspace preview version identity', () => {
    it('does not cache mutable working-tree bytes without a revision, even when their size is known', () => {
        for (const sizeBytes of [undefined, null, 1046]) {
            const identity = buildWorkspacePreviewIdentity(scope, 'assets/logo-dark.svg', sizeBytes);
            expect(identity.cacheScopeId).not.toBe('');
            expect(identity.cacheKey).toBeNull();
        }
    });

    it('treats an empty revision as unknown instead of making one immortal file key', () => {
        expect(buildWorkspacePreviewIdentity(scope, 'assets/logo-dark.svg', 1046, '').cacheKey).toBeNull();
        expect(buildWorkspacePreviewIdentity(scope, 'assets/logo-dark.svg', 1046, '   ').cacheKey).toBeNull();
    });

    it('shares a known version but separates equal-size edits and other workspaces', () => {
        const original = buildWorkspacePreviewIdentity(scope, 'assets/logo-dark.svg', 1046, 'sha-original');
        expect(original.cacheKey).not.toBeNull();
        expect(buildWorkspacePreviewIdentity({ ...scope }, 'assets/logo-dark.svg', 1046, 'sha-original')).toEqual(original);
        const edited = buildWorkspacePreviewIdentity(scope, 'assets/logo-dark.svg', 1046, 'sha-edited');
        expect(edited.cacheKey).not.toBe(original.cacheKey);
        expect(edited.cacheScopeId).toBe(original.cacheScopeId);
        expect(buildWorkspacePreviewIdentity({ ...scope, rootPath: '/other' }, 'assets/logo-dark.svg', 1046, 'sha-original').cacheScopeId)
            .not.toBe(original.cacheScopeId);
    });
});
