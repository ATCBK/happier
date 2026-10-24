import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';
import type { ScmStatus } from '@/sync/domains/state/storageTypes';
import type { AppRailBadgeSignal } from '@/components/navigation/shell/appRail/AppRailBadge';

installNavigationCommonModuleMocks();
const { GitActionRailBadge } = await import('./GitActionRailBadge');
const status: ScmStatus = {
    branch: 'main', isDirty: true, changedFileCount: 3, includedCount: 0,
    lastUpdatedAt: 0, includedLinesAdded: 0, includedLinesRemoved: 0,
    pendingLinesAdded: 42, pendingLinesRemoved: 8, linesAdded: 42, linesRemoved: 8, linesChanged: 50,
};

describe('Git action rail badge', () => {
    it('shows changed files and follows diff/off preferences through the real badge owner', async () => {
        const screen = await renderScreen(<GitActionRailBadge scmStatus={status} mode="changedFiles" testID="git-badge" />);
        expect(screen.findAllHostsByTestId('git-badge')).toHaveLength(1);
        expect(screen.getTextContent()).toBe('3');
        await screen.update(<GitActionRailBadge scmStatus={status} mode="diffLines" testID="git-badge" />);
        expect(screen.getTextContent()).toContain('+42');
        expect(screen.getTextContent()).toContain('−8');
        await screen.update(<GitActionRailBadge scmStatus={status} mode="off" testID="git-badge" />);
        expect(screen.findAllHostsByTestId('git-badge')).toHaveLength(0);
        let signal: AppRailBadgeSignal | null = null;
        const renderSignal = (value: AppRailBadgeSignal | null) => { signal = value; return null; };
        await screen.update(<GitActionRailBadge scmStatus={status} mode="diffLines" renderSignal={renderSignal} />);
        expect(signal).toEqual({ kind: 'count', tone: 'neutral', value: 3 });
        await screen.update(<GitActionRailBadge scmStatus={status} mode="off" renderSignal={renderSignal} />);
        expect(signal).toBeNull();
    });
    it('uses file count for incomplete status and hides a clean tree', async () => {
        const screen = await renderScreen(<GitActionRailBadge scmStatus={{ ...status, isComplete: false }} mode="diffLines" testID="git-badge" />);
        expect(screen.getTextContent()).toBe('3');
        await screen.update(<GitActionRailBadge scmStatus={null} mode="changedFiles" testID="git-badge" />);
        expect(screen.findAllHostsByTestId('git-badge')).toHaveLength(0);
    });
});

// The project rail consumes this cached summary; it does not start an SCM controller.
it('renders cached workspace counts for the exact Home and active worktree', async () => {
    const { projectManager } = await import('@/sync/runtime/orchestration/projectManager');
    projectManager.clear();
    const scope = { serverId: 'home-a', machineId: 'machine', rootPath: '/repo/worktree-a' };
    const otherRoot = { ...scope, rootPath: '/repo/worktree-b' };
    const otherHome = { ...scope, serverId: 'home-b' };
    projectManager.updateWorkspaceScmStatus(scope, status);
    projectManager.updateWorkspaceScmStatus(otherRoot, { ...status, changedFileCount: 7 });
    projectManager.updateWorkspaceScmStatus(otherHome, { ...status, changedFileCount: 9 });
    expect(projectManager.getWorkspaceScmStatus(scope)).toBe(status);
    const screen = await renderScreen(<GitActionRailBadge scmStatus={projectManager.getWorkspaceScmStatus(scope)} mode="changedFiles" />);
    expect(screen.getTextContent()).toBe('3');
    await screen.update(<GitActionRailBadge scmStatus={projectManager.getWorkspaceScmStatus(otherRoot)} mode="changedFiles" />);
    expect(screen.getTextContent()).toBe('7');
    await screen.update(<GitActionRailBadge scmStatus={projectManager.getWorkspaceScmStatus(otherHome)} mode="changedFiles" />);
    expect(screen.getTextContent()).toBe('9');
    projectManager.clear();
});
