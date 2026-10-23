import * as React from 'react';

import {
    isPluginTranscriptActivityContentTypeV1,
    MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1,
    PluginTranscriptActivityResourceSnapshotV1Schema,
} from '@happier-dev/protocol/plugins/contributions/ui/transcriptActivities';

import {
    usePluginContextualResourceStoreOwner,
    type PluginContextualResourceStoreLease,
} from '@/components/plugins/surfaces/PluginContextualResourceStoreProvider';
import type { PluginUiProjectionModel, PluginUiTranscriptActivityProjection } from '@/sync/domains/plugins/ui/projection';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginUiPlatformV1 } from '@happier-dev/protocol/plugins/ui';
import {
    buildPluginTranscriptActivityIdentityKey,
    buildPluginTranscriptActivitySourceKey,
    type PluginTranscriptActivityLiveRow,
} from './pluginTranscriptActivityTranscriptItem';
import {
    usePluginTranscriptActivityDismissal,
} from './PluginTranscriptActivityDismissalProvider';

type ActivityProfile = PluginUiTranscriptActivityProjection;

function profileKey(profile: ActivityProfile): string {
    return JSON.stringify([
        profile.pluginId,
        profile.descriptorId,
        profile.resource.localId,
        profile.occurrenceId,
    ]);
}

function sortProfiles(profiles: readonly ActivityProfile[]): ActivityProfile[] {
    return profiles.slice().sort((left, right) => (
        left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    ));
}

function readSnapshot(bytes: Uint8Array, contentType: string) {
    if (!isPluginTranscriptActivityContentTypeV1(contentType)) return null;
    try {
        if (bytes.byteLength > MAX_PLUGIN_TRANSCRIPT_ACTIVITY_RESOURCE_BYTES_V1) return null;
        const parsed = PluginTranscriptActivityResourceSnapshotV1Schema.safeParse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        );
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function snapshotRows(params: Readonly<{
    profile: ActivityProfile;
    snapshot: NonNullable<ReturnType<typeof readSnapshot>>;
    sessionId: string;
    freshness: PluginTranscriptActivityLiveRow['freshness'];
}>): PluginTranscriptActivityLiveRow[] {
    const allowedActionIds = new Set(params.profile.actions.map((action) => action.localId));
    return params.snapshot.activities.map((activity) => ({
        pluginId: params.profile.pluginId,
        contributionId: params.profile.descriptorId,
        occurrenceId: params.profile.occurrenceId,
        sessionId: params.sessionId,
        resourceId: params.profile.resource.localId,
        localActivityId: activity.localActivityId,
        phase: activity.phase,
        title: activity.title,
        status: activity.status ?? null,
        progress: activity.progress
            ? { completed: activity.progress.completed, total: activity.progress.total }
            : null,
        checklist: activity.checklist.map((item) => ({
            id: item.id,
            label: item.label,
            state: item.state,
        })),
        dismissible: activity.dismissible,
        // Activity profiles are the same-plugin action allowlist. This vertical
        // deliberately only projects current references; it does not invent a
        // direct Action dispatch/caller path.
        actions: activity.actions.flatMap((action) => (
            allowedActionIds.has(action.actionId)
                ? [{
                    pluginId: params.profile.pluginId,
                    localId: action.actionId,
                    label: action.label ?? null,
                }]
                : []
        )),
        freshness: params.freshness,
    }));
}

function replaceProfileRows(
    previous: readonly PluginTranscriptActivityLiveRow[],
    profile: ActivityProfile,
    next: readonly PluginTranscriptActivityLiveRow[],
    priorCurrentRows: readonly PluginTranscriptActivityLiveRow[] = [],
): PluginTranscriptActivityLiveRow[] {
    const retained = previous.filter((activity) => !(
            activity.pluginId === profile.pluginId
            && activity.contributionId === profile.descriptorId
            && activity.resourceId === profile.resource.localId
            && activity.occurrenceId === profile.occurrenceId
    ));
    const priorByIdentity = new Map(previous.map((activity) => [
        buildPluginTranscriptActivityIdentityKey(activity),
        activity,
    ]));
    // A Resource refresh first projects a truthful stale LKG wrapper. When
    // the succeeding bytes are current again, prefer the preceding current
    // row over that temporary wrapper so unchanged domain rows recover their
    // referential identity without hiding either freshness state.
    for (const activity of priorCurrentRows) {
        priorByIdentity.set(buildPluginTranscriptActivityIdentityKey(activity), activity);
    }
    const nextWithRetainedIdentity = next.map((activity) => {
        const prior = priorByIdentity.get(buildPluginTranscriptActivityIdentityKey(activity));
        return prior && sameActivityRow(prior, activity) ? prior : activity;
    });
    const merged = [...retained, ...nextWithRetainedIdentity];
    return merged.length === previous.length && merged.every((activity, index) => activity === previous[index])
        ? previous as PluginTranscriptActivityLiveRow[]
        : merged;
}

function isProfileRow(
    activity: PluginTranscriptActivityLiveRow,
    profile: ActivityProfile,
): boolean {
    return activity.pluginId === profile.pluginId
        && activity.contributionId === profile.descriptorId
        && activity.resourceId === profile.resource.localId
        && activity.occurrenceId === profile.occurrenceId;
}

function sameActivityRow(
    left: PluginTranscriptActivityLiveRow,
    right: PluginTranscriptActivityLiveRow,
): boolean {
    if (
        left.pluginId !== right.pluginId
        || left.contributionId !== right.contributionId
        || left.occurrenceId !== right.occurrenceId
        || left.sessionId !== right.sessionId
        || left.resourceId !== right.resourceId
        || left.localActivityId !== right.localActivityId
        || left.phase !== right.phase
        || left.title !== right.title
        || left.status !== right.status
        || left.dismissible !== right.dismissible
        || left.freshness !== right.freshness
        || left.progress?.completed !== right.progress?.completed
        || left.progress?.total !== right.progress?.total
        || left.checklist.length !== right.checklist.length
        || left.actions.length !== right.actions.length
    ) return false;
    return left.checklist.every((item, index) => (
        item.id === right.checklist[index]?.id
        && item.label === right.checklist[index]?.label
        && item.state === right.checklist[index]?.state
    )) && left.actions.every((action, index) => (
        action.pluginId === right.actions[index]?.pluginId
        && action.localId === right.actions[index]?.localId
        && action.label === right.actions[index]?.label
    ));
}

function markProfileRowsStale(
    previous: readonly PluginTranscriptActivityLiveRow[],
    profile: ActivityProfile,
): PluginTranscriptActivityLiveRow[] {
    let changed = false;
    const next = previous.map((activity) => {
        if (
            activity.pluginId !== profile.pluginId
            || activity.contributionId !== profile.descriptorId
            || activity.resourceId !== profile.resource.localId
            || activity.occurrenceId !== profile.occurrenceId
            || activity.freshness === 'stale'
        ) {
            return activity;
        }
        changed = true;
        return { ...activity, freshness: 'stale' as const };
    });
    return changed ? next : previous as PluginTranscriptActivityLiveRow[];
}

/**
 * The transcript-only Resource consumer. It holds ephemeral view state for the
 * existing transcript host, but defers Resource authorization, invalidation,
 * reconnect/resynchronization, and occurrence retirement to the canonical adapters.
 */
export function usePluginTranscriptActivities(params: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    interactionEnabled: boolean;
    machineId: string | null;
    platform: PluginUiPlatformV1;
    pluginUiProjection: PluginUiProjectionModel | null;
    serverId: string | null;
    sessionId: string;
    /** True only for the canonical permanent Session-removal fact. */
    sessionRemoved?: boolean;
}>): Readonly<{
    activities: readonly PluginTranscriptActivityLiveRow[];
    dismissedActivityIds: ReadonlySet<string>;
    onDismissActivity: (identityKey: string) => void;
}> {
    const projectionReady = params.pluginUiProjection?.generation != null;
    const profiles = React.useMemo(() => sortProfiles(
        Object.values(params.pluginUiProjection?.transcriptActivitiesById ?? {}),
    ), [params.pluginUiProjection?.transcriptActivitiesById]);
    const resourceStoreOwner = usePluginContextualResourceStoreOwner();
    const [activities, setActivities] = React.useState<readonly PluginTranscriptActivityLiveRow[]>([]);
    const priorBindingKeyRef = React.useRef<string | null>(null);
    // This is bounded per currently admitted profile and survives only this
    // hook mount/binding. It is referential history for the projection, not a
    // Resource cache: bytes, LKG/currentness and subscriptions stay upstream.
    const priorCurrentRowsByProfileRef = React.useRef(
        new Map<string, readonly PluginTranscriptActivityLiveRow[]>(),
    );
    // Effect cleanup observes the next render through this ref. Pair the
    // removal fact with its exact Session id so navigation to a *different*
    // deleted target cannot revoke the prior target's provider-local LKG.
    const sessionRemovalRef = React.useRef({
        sessionId: params.sessionId,
        removed: params.sessionRemoved === true,
    });
    sessionRemovalRef.current = {
        sessionId: params.sessionId,
        removed: params.sessionRemoved === true,
    };
    const bindingKey = params.machineId
        ? `${params.sessionId}:${params.machineId}:${params.serverId ?? ''}`
        : null;
    const {
        dismissedActivityIds,
        dismissActivity,
        reconcileActivitySource,
    } = usePluginTranscriptActivityDismissal({
        accountLifetime: params.accountLifetime,
        sessionId: params.sessionId,
        machineId: params.machineId,
        serverId: params.serverId,
        ready: projectionReady,
        sessionRemoved: params.sessionRemoved,
    });
    const priorProfileSourcesRef = React.useRef<Readonly<{
        bindingKey: string | null;
        sourceKeys: ReadonlySet<string>;
    }>>({ bindingKey: null, sourceKeys: new Set() });

    // Profile omission is an authoritative source omission, unlike a stale or
    // malformed Resource read. Revoke only dismissals owned by that removed
    // source; sibling Activity descriptors retain their local presentation.
    React.useEffect(() => {
        const sourceKeys = new Set(profiles.map((profile) => buildPluginTranscriptActivitySourceKey({
            pluginId: profile.pluginId,
            contributionId: profile.descriptorId,
            occurrenceId: profile.occurrenceId,
            sessionId: params.sessionId,
            resourceId: profile.resource.localId,
        })));
        const prior = priorProfileSourcesRef.current;
        if (prior.bindingKey === bindingKey) {
            for (const sourceKey of prior.sourceKeys) {
                if (!sourceKeys.has(sourceKey)) reconcileActivitySource(sourceKey, new Set());
            }
        }
        priorProfileSourcesRef.current = { bindingKey, sourceKeys };
    }, [bindingKey, params.sessionId, profiles, reconcileActivitySource]);

    // An occurrence/profile replacement is a lifecycle retirement, not an
    // offline event: prior Resource bytes may not seed the replacement.
    React.useEffect(() => {
        if (params.sessionRemoved || !projectionReady || profiles.length === 0 || !params.machineId) {
            setActivities([]);
            priorBindingKeyRef.current = null;
            priorCurrentRowsByProfileRef.current.clear();
            return;
        }
        if (priorBindingKeyRef.current !== bindingKey) {
            priorBindingKeyRef.current = bindingKey;
            // A Session/machine replacement is a new contextual
            // Resource binding. Its rows may not seed the next binding before
            // a current snapshot says they still exist.
            setActivities([]);
            priorCurrentRowsByProfileRef.current.clear();
            return;
        }
        const admittedProfiles = new Set(profiles.map(profileKey));
        for (const key of priorCurrentRowsByProfileRef.current.keys()) {
            if (!admittedProfiles.has(key)) priorCurrentRowsByProfileRef.current.delete(key);
        }
        setActivities((previous) => {
            const next = previous.filter((activity) => admittedProfiles.has(JSON.stringify([
                activity.pluginId,
                activity.contributionId,
                activity.resourceId,
                activity.occurrenceId,
            ])));
            return next.length === previous.length ? previous : next;
        });
    }, [bindingKey, params.machineId, params.sessionRemoved, profiles, projectionReady]);

    React.useEffect(() => {
        priorCurrentRowsByProfileRef.current.clear();
        if (!params.accountLifetime) return;
        const retirement = params.accountLifetime.onRetire(() => {
            setActivities([]);
            priorCurrentRowsByProfileRef.current.clear();
        });
        return () => retirement.dispose();
    }, [params.accountLifetime]);

    React.useEffect(() => {
        if (
            params.sessionRemoved
            || !projectionReady
            || !params.machineId
            || !params.accountLifetime
            || profiles.length === 0
            || !resourceStoreOwner
        ) {
            if (!params.accountLifetime || params.sessionRemoved) setActivities([]);
            return;
        }

        let cancelled = false;
        const isCurrent = (): boolean => !cancelled && (params.accountLifetime?.isCurrent() ?? true);
        // Profiles only lease the app-local generic contextual Resource store.
        // That owner owns the one read/watch/LKG/reconnect lifecycle for an
        // exact Account/plugin/machine/occurrence/host-stamped Session binding.
        const leasesByPluginId = new Map<string, PluginContextualResourceStoreLease>();
        const storeForProfile = (profile: ActivityProfile) => {
            const existing = leasesByPluginId.get(profile.pluginId);
            if (existing) return existing.store;
            const lease = resourceStoreOwner.acquire({
                accountLifetime: params.accountLifetime!,
                pluginId: profile.pluginId,
                machineId: params.machineId!,
                serverId: params.serverId,
                expectedCallerOccurrenceId: profile.occurrenceId,
                context: { kind: 'session', sessionId: params.sessionId },
            });
            if (!lease) return null;
            leasesByPluginId.set(profile.pluginId, lease);
            return lease.store;
        };
        const resources: Array<Readonly<{ dispose(): void }>> = [];
        for (const profile of profiles) {
            const store = storeForProfile(profile);
            if (!store) continue;
            const entry = store.getEntry(profile.resource);
            const applySnapshot = (): void => {
                const resource = entry.getSnapshot();
                if (!isCurrent()) return;
                const value = resource.value;
                const snapshot = value ? readSnapshot(value.bytes, value.contentType) : null;
                if (!snapshot) {
                    // A successful Resource read can still fail the Activity
                    // contract. Preserve the last validated rows, but make
                    // their uncertainty explicit instead of treating them as
                    // current until another valid snapshot replaces them.
                    if (value || resource.error || resource.freshness === 'stale') {
                        setActivities((previous) => markProfileRowsStale(previous, profile));
                    }
                    return;
                }
                const nextRows = snapshotRows({
                    profile,
                    snapshot,
                    sessionId: params.sessionId,
                    freshness: resource.freshness === 'fresh' ? 'current' : 'stale',
                });
                reconcileActivitySource(
                    buildPluginTranscriptActivitySourceKey(nextRows[0] ?? {
                        pluginId: profile.pluginId,
                        contributionId: profile.descriptorId,
                        occurrenceId: profile.occurrenceId,
                        sessionId: params.sessionId,
                        resourceId: profile.resource.localId,
                    }),
                    new Set(nextRows.map(buildPluginTranscriptActivityIdentityKey)),
                );
                const profileCurrentRows = resource.freshness === 'fresh'
                    ? priorCurrentRowsByProfileRef.current.get(profileKey(profile))
                    : undefined;
                setActivities((previous) => {
                    const nextActivities = replaceProfileRows(
                        previous,
                        profile,
                        nextRows,
                        profileCurrentRows,
                    );
                    if (resource.freshness === 'fresh') {
                        priorCurrentRowsByProfileRef.current.set(
                            profileKey(profile),
                            nextActivities.filter((activity) => isProfileRow(activity, profile)),
                        );
                    }
                    return nextActivities;
                });
            };
            const unsubscribe = entry.subscribe(applySnapshot, true);
            applySnapshot();
            resources.push(Object.freeze({
                dispose(): void {
                    unsubscribe();
                },
            }));
        }
        return () => {
            cancelled = true;
            resources.forEach((resource) => resource.dispose());
            leasesByPluginId.forEach((lease) => {
                const currentRemoval = sessionRemovalRef.current;
                if (currentRemoval.sessionId === params.sessionId && currentRemoval.removed) lease.retire();
                else lease.dispose();
            });
        };
    }, [
        params.accountLifetime,
        params.machineId,
        params.sessionRemoved,
        params.serverId,
        params.sessionId,
        profiles,
        projectionReady,
        reconcileActivitySource,
        resourceStoreOwner,
    ]);

    const onDismissActivity = React.useCallback((identityKey: string) => {
        const activity = activities.find((candidate) => (
            buildPluginTranscriptActivityIdentityKey(candidate) === identityKey
        ));
        if (!activity || !activity.dismissible || activity.phase === 'running') return;
        dismissActivity(identityKey, buildPluginTranscriptActivitySourceKey(activity));
    }, [activities, dismissActivity]);

    return React.useMemo(() => ({
        activities,
        dismissedActivityIds,
        onDismissActivity,
    }), [activities, dismissedActivityIds, onDismissActivity]);
}
