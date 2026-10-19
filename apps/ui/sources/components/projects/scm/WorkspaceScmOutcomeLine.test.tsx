import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { EMPTY_SCM_CAPABILITIES } from '@/scm/core/snapshotMappers';
import { storage } from '@/sync/domains/state/storage';
import type { ScmWorkingSnapshot } from '@/sync/domains/state/storageTypes';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import type { machineScmCommitUndoLast } from '@/sync/ops/scm/machineScm';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});
// This Git path never renders the external streaming Markdown package.
vi.mock('react-native-enriched-markdown/lib/module/web/streamingReveal.js', () => ({
    splitStreamingRevealTextParts: () => { throw new Error('Unexpected streaming Markdown in Git'); },
}));
const { undo } = vi.hoisted(() => ({ undo: vi.fn<typeof machineScmCommitUndoLast>() }));
// RPC is the system boundary. The store, outcome projection, component and mutation owner remain real.
vi.mock('@/sync/ops/scm/machineScm', () => ({ machineScmCommitUndoLast: undo }));

import { WorkspaceScmOutcomeLine } from './WorkspaceScmOutcomeLine';

const scope = { serverId: 'home-1', machineId: 'machine-1', rootPath: '/outcome-repo' };
const snapshot: ScmWorkingSnapshot = {
    projectKey: 'outcome-project', fetchedAt: 1,
    repo: { isRepo: true, rootPath: scope.rootPath, backendId: 'git', mode: '.git' },
    capabilities: { ...EMPTY_SCM_CAPABILITIES, writeCommitUndoLast: true },
    branch: { head: 'main', headOid: 'b'.repeat(40), upstream: null, ahead: 1, behind: 0, detached: false },
    hasConflicts: false, entries: [],
    totals: { includedFiles: 0, pendingFiles: 0, untrackedFiles: 0, includedAdded: 0, includedRemoved: 0, pendingAdded: 0, pendingRemoved: 0 },
};

describe('workspace Git outcome consumption', () => {
    beforeEach(() => {
        projectManager.clear();
        undo.mockReset().mockResolvedValue({
            success: false,
            outcome: { v: 1, kind: 'needs_input', errorCode: 'COMMIT_UNDO_HEAD_CHANGED', nextActions: [{ kind: 'refresh' }] },
        });
        storage.getState().appendWorkspaceScmOperation(scope, {
            operation: 'commit', status: 'success', timestamp: Date.now(),
            outcome: { v: 1, kind: 'succeeded', effect: { kind: 'commit', commitSha: 'a'.repeat(40) }, nextActions: [] },
        });
    });

    it('undoes the successful result shown to the user and displays a changed-HEAD refusal inline', async () => {
        const refresh = vi.fn(async () => {});
        const screen = await renderScreen(<WorkspaceScmOutcomeLine scope={scope} snapshot={snapshot}
            selectedCount={1} writeEnabled onRefresh={refresh} />);
        await screen.pressByTestIdAsync('session-git-outcome-undo');
        expect(undo).toHaveBeenCalledWith('machine-1', {
            cwd: scope.rootPath, expectedHeadOid: 'a'.repeat(40),
        }, { serverId: 'home-1', onDispatched: expect.any(Function) });
        expect(screen.findHostByTestId('session-git-outcome-needs_input')).not.toBeNull();
        expect(refresh).not.toHaveBeenCalled();
    });

    it('shows the commit result without offering an undo when workspace writes are disabled', async () => {
        const screen = await renderScreen(<WorkspaceScmOutcomeLine scope={scope} snapshot={snapshot}
            selectedCount={0} writeEnabled={false} onRefresh={async () => {}} />);
        expect(screen.findHostByTestId('session-git-outcome-succeeded')).not.toBeNull();
        expect(screen.findHostByTestId('session-git-outcome-undo')).toBeNull();
    });
});
