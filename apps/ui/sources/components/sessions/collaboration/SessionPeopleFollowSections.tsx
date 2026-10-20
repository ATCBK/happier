import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { projectFollowPolicyEditorV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';
import type { FollowSourceRelationV1, SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { resolveFollowDeliveryV1, type FollowEventV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

import { useRouter, type Href } from '@/components/appShell/workspace/destinationRoute';
import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { projectAccountSessionFollowPolicyEditor } from '@/components/sessions/follow/accountSessionFollowController';
import { SessionFollowSourcesEditor } from '@/components/sessions/follow/SessionFollowSourcesEditor';
import { FollowEditorPanel } from '@/components/sessions/follow/FollowEditorPanel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { useIsTablet } from '@/utils/platform/responsive';
import { useAccountSessionFollowController } from '@/components/sessions/follow/useAccountSessionFollowController';
import { useAccountSessionFollowEditorHost } from '@/components/sessions/follow/useAccountSessionFollowEditorHost';
import { useSessionFollowers } from '@/components/sessions/follow/useSessionFollowers';
import { useSessionFollowing } from '@/components/sessions/follow/useSessionFollowing';
import { describeSessionFollowLevel } from '@/components/sessions/follow/sessionFollowLevelCopy';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PaneSectionHeader } from '@/components/ui/lists/PaneSectionHeader';
import { Item } from '@/components/ui/lists/Item';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { useSessionDisplayTitles } from '@/utils/sessions/sessionDisplayTitle';

type FollowPreset = 'everything' | 'important' | 'quiet' | 'custom';

/** The rows' identity mark, in the leading column every pane row shares (a person, a session, people). */
function FollowerMark(props: Readonly<{ name: IconName }>) {
    const { theme } = useUnistyles();
    return <Icon name={props.name} size={18} color={theme.colors.text.secondary} />;
}

/** A person's level in one line: the level, then what it means for them (Settings → Coordination's words). */
function describePersonLevel(preset: FollowPreset): string {
    const meaning = preset === 'everything' ? t('settingsCoordination.levelEverythingHint')
        : preset === 'important' ? t('settingsCoordination.levelImportantHint')
            : preset === 'quiet' ? t('settingsCoordination.levelQuietHint') : null;
    return joinHappierFacts(t(`session.follow.policy.${preset}`), meaning);
}

type SessionFollowerRelation = Readonly<{
    relation: 'manager' | 'follower';
    policy: SessionFollowSourceV1['policy'];
    deliveryState: SessionFollowSourceV1['deliveryState'];
}>;

type SessionFollowerDelivery = Readonly<{
    delivery: 'wake' | 'next_turn' | 'off';
    via: readonly SessionFollowerRelation['relation'][];
}>;

const followerEvents = {
    needsYouDecision: { kind: 'needs_you', type: 'decision' },
    needsYouApproval: { kind: 'needs_you', type: 'approval' },
    needsYouBlocked: { kind: 'needs_you', type: 'blocked' },
    needsYouContinue: { kind: 'needs_you', type: 'decision', mode: 'continue' },
    finished: { kind: 'finished' },
    failedOrStopped: { kind: 'failed_or_stopped' },
    stalled: { kind: 'stalled' },
    updatePosted: { kind: 'update_posted' },
    personWrote: { kind: 'person_wrote' },
    goalChanged: { kind: 'goal_changed' },
    message: { kind: 'message' },
} as const satisfies Record<string, FollowEventV1>;

/** Ask for an actual event, including its needs-you type, mode and handler. */
export function projectFollowerDelivery(follower: Pick<SessionFollower, 'relations'>, event: FollowEventV1): SessionFollowerDelivery {
    const decision = resolveFollowDeliveryV1({ policies: follower.relations.map((relation) => relation.policy), event });
    return {
        delivery: decision.session.wake ? 'wake' : decision.session.nextTurn ? 'next_turn' : 'off',
        // The canonical resolver's selected flag always projects to one session channel.
        via: follower.relations.filter((relation) => resolveFollowDeliveryV1({ policies: [relation.policy], event }).selected)
            .map((relation) => relation.relation),
    };
}

export type SessionFollower = Readonly<{
    sessionId: string;
    manager: boolean;
    relations: readonly SessionFollowerRelation[];
    /** Policy intent, before receiver availability or source access is applied. */
    effective: Readonly<{ [K in keyof typeof followerEvents]: SessionFollowerDelivery }>;
}>;

/**
 * Who follows, from the reverse read: one row per following session (a receiver can hold both a
 * follower and a manager relation), the people census (which counts you when your own follow is
 * active) and the other people. Unknown stays null, never zero.
 */
export function projectSessionFollowerCensus(projection: Readonly<{
    sources: readonly FollowSourceRelationV1[];
    follows: readonly unknown[];
    peopleCount?: number;
}> | null): Readonly<{ sessions: readonly SessionFollower[] | null; peopleCount: number | null; otherPeople: number | null }> {
    if (!projection) return { sessions: null, peopleCount: null, otherPeople: null };
    const byReceiver = new Map<string, { sessionId: string; relations: SessionFollowerRelation[] }>();
    for (const source of projection.sources) {
        // This is the reverse census for one Session source. Other source kinds
        // share Follow's list transport but are not followers of this Session.
        if (!('sourceSessionId' in source)) continue;
        const current = byReceiver.get(source.destinationSessionId)
            ?? { sessionId: source.destinationSessionId, relations: [] };
        current.relations.push({ relation: source.relation ?? 'follower', policy: source.policy, deliveryState: source.deliveryState });
        byReceiver.set(source.destinationSessionId, current);
    }
    const peopleCount = projection.peopleCount ?? null;
    return {
        sessions: [...byReceiver.values()].map(({ sessionId, relations }) => {
            const decision = (event: FollowEventV1) => projectFollowerDelivery({ relations }, event);
            return {
                sessionId,
                manager: relations.some((relation) => relation.relation === 'manager'),
                relations,
                effective: {
                    needsYouDecision: decision(followerEvents.needsYouDecision),
                    needsYouApproval: decision(followerEvents.needsYouApproval),
                    needsYouBlocked: decision(followerEvents.needsYouBlocked),
                    needsYouContinue: decision(followerEvents.needsYouContinue),
                    finished: decision(followerEvents.finished),
                    failedOrStopped: decision(followerEvents.failedOrStopped),
                    stalled: decision(followerEvents.stalled),
                    updatePosted: decision(followerEvents.updatePosted),
                    personWrote: decision(followerEvents.personWrote),
                    goalChanged: decision(followerEvents.goalChanged),
                    message: decision(followerEvents.message),
                },
            };
        }),
        peopleCount,
        otherPeople: peopleCount === null ? null : Math.max(0, peopleCount - (projection.follows.length > 0 ? 1 : 0)),
    };
}

/**
 * Who hears about this session, and what it hears about (coordination lab P1-P): Followers, then
 * Following, drawn flat under the Discussions in the same scroller, as the pane's sections are.
 *
 * Followers: your own level (the Follow editor's one controller), the sessions that follow it from
 * the authoritative reverse read (`useSessionFollowers`), and how many other people do — never who,
 * and never their levels. The pane header says both in one line (lab P1-CP: "Follows 2 rules · 1 session",
 * then "3 people · 2 sessions follow it"), from the same Following census the list below renders.
 */
export const SessionPeopleFollowSections = React.memo(function SessionPeopleFollowSections(props: Readonly<{
    target: SessionAddress;
    session: Session | null;
    /** Attached to the Following section so "Edit what it follows" can bring it into view. */
    followingAnchorRef?: React.RefObject<View | null>;
}>) {
    const followEditor = useAccountSessionFollowEditorHost({ serverId: props.target.serverId, sessionId: props.target.sessionId });
    const followers = useSessionFollowers(props.target, followEditor.enabled);
    const census = React.useMemo(() => projectSessionFollowerCensus(followers.projection), [followers.projection]);
    const { sessions, peopleCount, otherPeople } = census;
    const followingEnabled = useFeatureEnabled('sessions.following', { scopeKind: 'spawn', serverId: props.target.serverId });
    const following = useSessionFollowing(props.target, followingEnabled);
    const machineId = props.session ? (readSessionOwnerMetadataView(props.session)?.machineId ?? null) : null;
    // Following reads this session's own relations by its identity: it stays whole while the session's snapshot loads.
    const destination = React.useMemo(() => ({ id: props.target.sessionId }), [props.target.sessionId]);

    const followingProjection = following.projection;
    const headerLine = React.useMemo(() => {
        // What it follows: its rules, then the Sessions it follows by name (other source kinds stay in the list).
        const ruleCount = followingProjection?.rules.length ?? 0;
        const followedSessions = followingProjection?.sources.filter((source) => 'sourceSessionId' in source).length ?? 0;
        const follows = joinHappierFacts(
            ruleCount > 0 ? t('session.collaboration.pane.followingRules', { count: ruleCount }) : null,
            followedSessions > 0 ? t('session.collaboration.pane.followersSessions', { count: followedSessions }) : null,
        );
        const sessionCount = sessions?.length ?? 0;
        const people = peopleCount ?? 0;
        const followedBy = sessions && sessionCount + people > 0
            ? t('session.collaboration.pane.followedBy', {
                facts: joinHappierFacts(
                    people > 0 ? t('session.collaboration.pane.followersPeople', { count: people }) : null,
                    sessionCount > 0 ? t('session.collaboration.pane.followersSessions', { count: sessionCount }) : null,
                ),
                count: sessionCount + people,
            })
            : null;
        const segments = [follows ? t('session.collaboration.pane.follows', { facts: follows }) : null, followedBy]
            .filter((segment): segment is string => segment !== null);
        return segments.length > 0 ? { segments } : null;
    }, [followingProjection, peopleCount, sessions]);
    usePaneHeaderSlotContent(React.useMemo(() => ({ line: headerLine }), [headerLine]));

    return (
        <>
            {followEditor.enabled ? (
                <View testID="session-people-followers" style={styles.section}>
                    <PaneSectionHeader title={t('session.collaboration.pane.followersTitle')}
                        count={sessions && peopleCount !== null ? sessions.length + peopleCount : undefined} />
                    <SessionPeopleYouRow target={props.target} openEditor={followEditor.openEditor}
                        anchorRef={followEditor.anchorRef} triggerRef={followEditor.triggerRef} />
                    {sessions && sessions.length > 0 ? <SessionFollowerRows target={props.target} followers={sessions} /> : null}
                    {otherPeople ? (
                        <Item testID="session-people-followers-people" density="compact" showDivider={false} showChevron={false}
                            icon={<FollowerMark name="users" />}
                            title={t('session.collaboration.pane.followersPeople', { count: otherPeople })}
                            subtitle={t('session.collaboration.pane.followersPeopleNote')} />
                    ) : null}
                </View>
            ) : null}
            {followEditor.editor}
            <View ref={props.followingAnchorRef} tabIndex={-1} collapsable={false} testID="session-people-following">
                <SessionFollowSourcesEditor destination={destination} serverId={props.target.serverId}
                    destinationMachineId={machineId} following={following} />
            </View>
        </>
    );
});


/**
 * A follower row's one line. One relation says its level and what that wakes. A receiver that is both its manager
 * and an ordinary follower stays one row: who it is, that it also follows, and the union the Home delivers
 * (wake, next turn, or no events selected), never just one relation's level.
 */
export function describeSessionFollower(follower: Pick<SessionFollower, 'manager' | 'relations' | 'effective'>): string {
    const manager = follower.manager ? t('session.collaboration.pane.followersManager') : null;
    const [only] = follower.relations;
    if (only && follower.relations.length === 1) {
        return joinHappierFacts(manager, describeSessionFollowLevel(projectFollowPolicyEditorV1(only.policy).preset as FollowPreset));
    }
    const deliveries = Object.values(follower.effective);
    const meaning = deliveries.some((event) => event.delivery === 'wake')
        ? t('session.collaboration.pane.followersEffectiveWake')
        : deliveries.some((event) => event.delivery === 'next_turn')
            ? t('session.collaboration.pane.followersEffectiveNextTurn')
            : t('session.collaboration.pane.followersEffectiveOff');
    return joinHappierFacts(
        manager,
        t('session.collaboration.pane.followersAlsoFollows'),
        meaning,
    );
}

/**
 * The sessions that follow this one, named through the batched title projection. A row opens the same Follow
 * panel as the follower's own Following row (lab P2-S): "<follower> follows this", why, and how much it hears,
 * anchored to the row on a wide window and a pushed page on a phone. A receiver that hears only as this session's
 * manager has no ordinary follow to edit here, so its panel says where that is changed.
 */
export function SessionFollowerRows(props: Readonly<{ target: SessionAddress; followers: readonly SessionFollower[] }>) {
    const router = useRouter();
    const anchored = useIsTablet();
    const [openId, setOpenId] = React.useState<string | null>(null);
    const addresses = React.useMemo(() => props.followers.map((follower) => ({ sessionId: follower.sessionId, serverId: props.target.serverId })),
        [props.target.serverId, props.followers]);
    const titles = useSessionDisplayTitles(addresses);
    const open = (followerId: string) => {
        if (anchored) { setOpenId(followerId); return; }
        router.push(buildScopedSessionRouteHref({
            sessionId: followerId,
            serverId: props.target.serverId,
            suffix: '/follow-source',
            query: { source: props.target.sessionId },
        }) as Href);
    };
    return <>
        {props.followers.map((follower, index) => {
            const title = titles[index] ?? t('session.untitled');
            return <SessionFollowerRow key={follower.sessionId} target={props.target} follower={follower} title={title}
                open={anchored && openId === follower.sessionId} onOpen={() => open(follower.sessionId)} onClose={() => setOpenId(null)} />;
        })}
    </>;
}

function SessionFollowerRow(props: Readonly<{
    target: SessionAddress;
    follower: SessionFollower;
    title: string;
    open: boolean;
    onOpen(): void;
    onClose(): void;
}>) {
    const anchorRef = React.useRef<View>(null);
    const triggerRef = React.useRef<React.ComponentRef<typeof Pressable>>(null);
    const why = describeSessionFollower(props.follower);
    const panel = (parts: Readonly<{ body: React.ReactNode; footer: React.ReactNode }>) => (
        <FollowEditorPanel anchorRef={anchorRef} focusReturnRef={triggerRef} onRequestClose={props.onClose}
            testID={`session-people-follower-session-${props.follower.sessionId}-panel`}
            accessibilityLabel={t('session.follow.sources.followsThis', { title: props.title })}
            title={t('session.follow.sources.followsThis', { title: props.title })} subtitle={why}
            mark={<FollowerMark name="stack" />} footer={parts.footer}>
            {parts.body}
        </FollowEditorPanel>
    );
    const ordinary = props.follower.relations.some((relation) => relation.relation === 'follower');
    return <>
        <View ref={anchorRef} collapsable={false}>
            <Item pressableRef={triggerRef} testID={`session-people-follower-session-${props.follower.sessionId}`}
                density="compact" showDivider={false} title={props.title} icon={<FollowerMark name="stack" />}
                subtitle={why} subtitleLines={2} onPress={props.onOpen} />
        </View>
        {props.open ? (ordinary
            // The follower's own editor and writers, placing this one source's panel at this row.
            ? <SessionFollowSourcesEditor destination={{ id: props.follower.sessionId }} serverId={props.target.serverId}
                destinationMachineId={null}
                page={{ sourceKey: props.target.sessionId, onClose: props.onClose, frame: panel }} />
            : panel({
                body: <Item density="compact" showDivider={false} showChevron={false} mode="info" titleLines={0}
                    title={t('session.follow.sources.managerOnly')} />,
                footer: <SectionButtonRow trailing={<RoundButton title={t('common.done')} onPress={props.onClose} />}>{null}</SectionButtonRow>,
            })) : null}
    </>;
}

type FollowEditorHost = ReturnType<typeof useAccountSessionFollowEditorHost>;

/** Your own level and what it means; the row opens the same Follow editor the session header does. */
function SessionPeopleYouRow(props: Readonly<{
    target: SessionAddress;
    openEditor: FollowEditorHost['openEditor'];
    anchorRef: FollowEditorHost['anchorRef'];
    triggerRef: FollowEditorHost['triggerRef'];
}>) {
    const { state } = useAccountSessionFollowController(props.target, true);
    const level = React.useMemo(() => {
        if (!state.projection) return null;
        const editor = projectAccountSessionFollowPolicyEditor(state);
        if (!editor.following || !editor.model) return t('session.follow.level.none');
        return describePersonLevel(editor.model.preset as FollowPreset);
    }, [state]);
    const { openEditor, target } = props;
    const open = React.useCallback(() => openEditor({ address: target }), [openEditor, target]);
    return (
        <View ref={props.anchorRef} collapsable={false}>
            <Item pressableRef={props.triggerRef} testID="session-people-follower-you" density="compact" showDivider={false}
                icon={<FollowerMark name="user-circle" />}
                title={t('session.collaboration.pane.followersYou')}
                subtitle={level ?? undefined}
                subtitleLines={2}
                loading={level === null && state.loading}
                onPress={open} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    section: { paddingTop: theme.space.s12 },
}));
