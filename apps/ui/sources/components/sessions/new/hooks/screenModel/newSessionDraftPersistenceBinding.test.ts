import { describe, expect, it } from 'vitest';

import {
    createNewSessionDraftPersistenceBinding,
    persistNewSessionDraftAndPause,
} from './newSessionDraftPersistenceBinding';

describe('newSessionDraftPersistenceBinding', () => {
    const homeA: Readonly<{ serverId: string; accountId: string }> = { serverId: 'home-a', accountId: 'account-a' };
    const homeB: Readonly<{ serverId: string; accountId: string }> = { serverId: 'home-b', accountId: 'account-b' };

    it('pauses immutable launch review, rebinds target-first, and resumes only the exact destination', () => {
        const binding = createNewSessionDraftPersistenceBinding(homeA);
        expect(binding.readScopeForWrite()).toEqual(homeA);

        binding.pause(homeA);
        expect(binding.readScopeForWrite()).toBeNull();
        binding.pause(homeB);
        expect(binding.readScopeForWrite()).toBeNull();

        expect(binding.resume(homeA)).toBe(false);
        expect(binding.readScopeForWrite()).toBeNull();
        expect(binding.resume(homeB)).toBe(true);
        expect(binding.readScopeForWrite()).toEqual(homeB);
        binding.follow(homeA);
        expect(binding.readScopeForWrite()).toEqual(homeB);
    });

    it('supports same-Home abandonment and remount without reviving a permanently disabled writer', () => {
        const sameHome = createNewSessionDraftPersistenceBinding(homeA);
        sameHome.pause(homeA);
        expect(sameHome.resume(homeA)).toBe(true);
        expect(sameHome.readScopeForWrite()).toEqual(homeA);

        const remounted = createNewSessionDraftPersistenceBinding(homeB);
        expect(remounted.readScopeForWrite()).toEqual(homeB);
        remounted.disable();
        expect(remounted.resume(homeB)).toBe(false);
        expect(remounted.readScopeForWrite()).toBeNull();
    });

    it('persists the complete live draft before pausing a same-Home launch', () => {
        const binding = createNewSessionDraftPersistenceBinding(homeA);
        const writes: Array<Readonly<{ scope: typeof homeA; draft: Record<string, unknown> }>> = [];
        const liveDraft = {
            input: 'latest text typed immediately before Send',
            selectedProfileId: 'profile-latest',
            modelSelection: { kind: 'custom', modelId: 'model-latest' },
            permissionMode: 'safe-yolo',
            capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['mcp-latest'], forceExcludeServerIds: [] } },
            executionTarget: { kind: 'temporary_computer', serverId: 'home-a', artifactTarget: 'linux-x64' },
        } as const;

        persistNewSessionDraftAndPause({
            binding,
            scope: homeA,
            persist: (scope) => {
                expect(binding.readScopeForWrite()).toEqual(homeA);
                writes.push({ scope, draft: liveDraft });
            },
        });

        expect(writes).toEqual([{ scope: homeA, draft: liveDraft }]);
        expect(binding.readScopeForWrite()).toBeNull();

        // Cancel resumes the same scoped writer; a remount restores the flushed
        // editable authoring rather than the older debounced value.
        expect(binding.resume(homeA)).toBe(true);
        expect(writes.at(-1)?.draft).toEqual(liveDraft);
    });

    it('flushes the source before a cross-Home move and leaves the destination paused', () => {
        const binding = createNewSessionDraftPersistenceBinding(homeA);
        const drafts = new Map<string, Record<string, unknown>>();
        const liveDraft = {
            input: 'cross-Home latest text',
            selectedProfileId: 'profile-b',
            modelSelection: { kind: 'custom', modelId: 'model-b' },
            permissionMode: 'read-only',
            capabilitySelection: { mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['mcp-b'], forceExcludeServerIds: [] } },
            executionTarget: { kind: 'temporary_computer', serverId: 'home-b', artifactTarget: 'darwin-arm64' },
        } as const;
        const key = (scope: typeof homeA | typeof homeB) => `${scope.serverId}:${scope.accountId}`;

        persistNewSessionDraftAndPause({
            binding,
            scope: homeA,
            persist: (scope) => drafts.set(key(scope), liveDraft),
        });
        const flushedSource = drafts.get(key(homeA));
        expect(flushedSource).toEqual(liveDraft);

        // This mirrors the existing canonical move owner: it reads the flushed
        // source, writes the destination, then the launch pins that destination.
        drafts.set(key(homeB), { ...flushedSource });
        binding.pause(homeB);

        expect(binding.readScopeForWrite()).toBeNull();
        expect(drafts.get(key(homeB))).toEqual(liveDraft);
        expect(binding.resume(homeA)).toBe(false);
        expect(binding.resume(homeB)).toBe(true);
        expect(drafts.get(key(homeB))).toEqual(liveDraft);
    });

    it('keeps the scoped writer enabled when the required final persist fails', () => {
        const binding = createNewSessionDraftPersistenceBinding(homeA);

        expect(() => persistNewSessionDraftAndPause({
            binding,
            scope: homeA,
            persist: () => {
                throw new Error('storage unavailable');
            },
        })).toThrow('storage unavailable');

        expect(binding.readScopeForWrite()).toEqual(homeA);
    });
});
