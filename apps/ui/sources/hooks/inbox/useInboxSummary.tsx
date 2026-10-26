import * as React from 'react';

import { useActivityOverviewSummary } from '@/activity/source/useActivityOverview';
import { useFriendsEnabled } from '@/hooks/server/useFriendsEnabled';
import { useFriendsIdentityReadiness } from '@/hooks/server/useFriendsIdentityReadiness';
import { isOpenApprovalInboxArtifact } from '@/sync/domains/artifacts/approvalArtifacts';
import { readAccountNoticeArtifactHeader, isUnreadAccountNotice } from '@/sync/domains/artifacts/usageNoticeArtifacts';
import { useInboxActionOperationSummary } from '@/sync/domains/actionOperations/useActionOperations';
import { useFriendRequestCount } from '@/sync/domains/state/storage';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { countInboxDiscussionItems, countInboxItems } from '@/components/inbox/inboxCounts';
import { useInboxDiscussionAttention } from './useInboxDiscussionSource';
import { InboxExecutionRunSourceBoundary, useInboxExecutionRunCount } from './useInboxExecutionRunSource';
import { InboxArtifactSourceBoundary, useInboxArtifactSource } from './useInboxArtifactSource';

import { useAutomationAttentionSource, useWorkflowAttentionSource, WorkflowAttentionSourceBoundary } from './useWorkflowAttentionSource';

export type InboxSummary = Readonly<{
    count: number | null;
    hasContent: boolean | null;
}>;

export function createOpenApprovalInboxCountSelector(): (state: StorageState) => number {
    let previousArtifacts: StorageState['artifacts'] | null = null;
    let previousIsDataReady = false;
    let previousAccountId: string | null | undefined;
    let previousCount = 0;
    let previousCountedIds = new Set<string>();

    return (state) => {
        if (state.artifacts === previousArtifacts && state.isDataReady === previousIsDataReady
            && state.profileScope?.accountId === previousAccountId) {
            return previousCount;
        }
        const accountId = state.profileScope?.accountId;
        const retainClassification = previousIsDataReady && previousAccountId === accountId;
        const countedIds = new Set<string>();
        if (state.isDataReady) {
            for (const artifact of Object.values(state.artifacts)) {
                // The Artifact store retains unchanged immutable rows. Carry this
                // snapshot's classification forward; changed bodies still enter
                // the strict reader, and removed rows leave the projection.
                if (retainClassification && artifact === previousArtifacts?.[artifact.id]) {
                    if (previousCountedIds.has(artifact.id)) countedIds.add(artifact.id);
                    continue;
                }
                const notice = readAccountNoticeArtifactHeader(artifact, accountId);
                if (isOpenApprovalInboxArtifact(artifact)
                    || (notice && isUnreadAccountNotice(notice))) countedIds.add(artifact.id);
            }
        }
        previousArtifacts = state.artifacts;
        previousIsDataReady = state.isDataReady;
        previousAccountId = accountId;
        previousCountedIds = countedIds;
        previousCount = countedIds.size;
        return previousCount;
    };
}

const selectOpenApprovalInboxCount = createOpenApprovalInboxCountSelector();

export function useInboxSummary(): InboxSummary {
    const activity = useActivityOverviewSummary();
    const artifactSource = useInboxArtifactSource();
    const serverId = storage(state => state.profileScope?.serverId ?? null);
    const openApprovalCount = storage(selectOpenApprovalInboxCount);
    const friendsEnabled = useFriendsEnabled();
    const friendsIdentityReadiness = useFriendsIdentityReadiness();
    const friendRequestCount = useFriendRequestCount();
    const actionOperations = useInboxActionOperationSummary();
    // Workflow attention is 03's window membership; the Inbox folds a step session's request
    // under its run, so a run is counted once here and its step rows are presentation.
    const workflowAttention = useWorkflowAttentionSource();
    const executionRuns = useInboxExecutionRunCount();
    const automationAttention = useAutomationAttentionSource();
    const discussionAttention = useInboxDiscussionAttention(serverId);
    const discussionCount = React.useMemo(() => countInboxDiscussionItems(discussionAttention.source), [discussionAttention.source]);
    const visibleFriendRequestCount = friendsEnabled && friendsIdentityReadiness.isReady
        ? friendRequestCount
        : 0;
    // The one Inbox count formula, fed from the always-mounted narrow projections; an open Inbox
    // feeds the same formula from its model, so the badge, popover and page agree.
    const count = countInboxItems({
        sessions: activity.inboxContentCount,
        workflowRuns: workflowAttention.runIds.length,
        executionRuns,
        automationRuns: automationAttention.runIds.length,
        approvalsAndNotices: openApprovalCount,
        operations: actionOperations.count,
        friendRequests: visibleFriendRequestCount,
        discussions: discussionCount,
    });

    return React.useMemo(() => artifactSource.phase === 'current' ? { count, hasContent: count > 0 }
        : { count: null, hasContent: null }, [count, artifactSource.phase]);
}

const InboxSummaryContext = React.createContext<InboxSummary | null>(null);

function InboxSummaryContextProvider(props: Readonly<{ children: React.ReactNode }>) {
    const summary = useInboxSummary();
    return (
        <InboxSummaryContext.Provider value={summary}>
            {props.children}
        </InboxSummaryContext.Provider>
    );
}

/** The app shell's one Inbox summary owner; it also mounts the one workflow attention loader. */
export function InboxSummaryProvider(props: Readonly<{ children: React.ReactNode }>) {
    return (
        <InboxArtifactSourceBoundary><WorkflowAttentionSourceBoundary>
            <InboxExecutionRunSourceBoundary><InboxSummaryContextProvider>{props.children}</InboxSummaryContextProvider></InboxExecutionRunSourceBoundary>
        </WorkflowAttentionSourceBoundary></InboxArtifactSourceBoundary>
    );
}

export function useSharedInboxSummary(): InboxSummary {
    const summary = React.useContext(InboxSummaryContext);
    if (!summary) throw new Error('useSharedInboxSummary must be rendered under InboxSummaryProvider');
    return summary;
}
