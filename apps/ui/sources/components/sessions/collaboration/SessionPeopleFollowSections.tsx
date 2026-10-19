import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { projectFollowPolicyEditorV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';
import type { SessionFollowSourceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { usePaneHeaderSlotContent } from '@/components/appShell/panes/paneHeaderSlot';
import { projectAccountSessionFollowPolicyEditor } from '@/components/sessions/follow/accountSessionFollowController';
import { SessionFollowSourcesEditor } from '@/components/sessions/follow/SessionFollowSourcesEditor';
import { useAccountSessionFollowController } from '@/components/sessions/follow/useAccountSessionFollowController';
import { useAccountSessionFollowEditorHost } from '@/components/sessions/follow/useAccountSessionFollowEditorHost';
import { useSessionFollowers } from '@/components/sessions/follow/useSessionFollowers';
import { describeSessionFollowLevel } from '@/components/sessions/follow/sessionFollowLevelCopy';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { PaneSectionHeader } from '@/components/ui/lists/PaneSectionHeader';
import { Item } from '@/components/ui/lists/Item';
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

type SessionFollower = Readonly<{ sessionId: string; manager: boolean; policy: SessionFollowSourceV1['policy'] }>;

/**
 * Who follows, from the reverse read: one row per following session (a receiver can hold both a
 * follower and a manager relation), the people census (which counts you when your own follow is
 * active) and the other people. Unknown stays null, never zero.
 */
export function projectSessionFollowerCensus(projection: Readonly<{
    sources: readonly SessionFollowSourceV1[];
    follows: readonly unknown[];
    peopleCount?: number;
}> | null): Readonly<{ sessions: readonly SessionFollower[] | null; peopleCount: number | null; otherPeople: number | null }> {
    if (!projection) return { sessions: null, peopleCount: null, otherPeople: null };
    const byReceiver = new Map<string, SessionFollower>();
    for (const source of projection.sources) {
        const current = byReceiver.get(source.destinationSessionId);
        byReceiver.set(source.destinationSessionId, {
            sessionId: source.destinationSessionId,
            manager: (current?.manager ?? false) || source.relation === 'manager',
            // The follow's own level; a manager-only relation shows the manager's.
            policy: current && source.relation === 'manager' ? current.policy : source.policy,
        });
    }
    const peopleCount = projection.peopleCount ?? null;
    return {
        sessions: [...byReceiver.values()],
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
 * and never their levels. The pane header says it in one line ("3 people · 2 sessions follow it").
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
    const machineId = props.session ? (readSessionOwnerMetadataView(props.session)?.machineId ?? null) : null;

    const headerLine = React.useMemo(() => {
        const sessionCount = sessions?.length ?? 0;
        const people = peopleCount ?? 0;
        if (!sessions || sessionCount + people === 0) return null;
        const facts = joinHappierFacts(
            people > 0 ? t('session.collaboration.pane.followersPeople', { count: people }) : null,
            sessionCount > 0 ? t('session.collaboration.pane.followersSessions', { count: sessionCount }) : null,
        );
        return { segments: [t('session.collaboration.pane.followedBy', { facts, count: sessionCount + people })] };
    }, [peopleCount, sessions]);
    usePaneHeaderSlotContent(React.useMemo(() => ({ line: headerLine }), [headerLine]));

    return (
        <>
            {followEditor.enabled ? (
                <View testID="session-people-followers" style={styles.section}>
                    <PaneSectionHeader title={t('session.collaboration.pane.followersTitle')}
                        count={sessions && peopleCount !== null ? sessions.length + peopleCount : undefined} />
                    <SessionPeopleYouRow target={props.target} openEditor={followEditor.openEditor}
                        anchorRef={followEditor.anchorRef} triggerRef={followEditor.triggerRef} />
                    {sessions && sessions.length > 0 ? <SessionFollowerRows serverId={props.target.serverId} followers={sessions} /> : null}
                    {otherPeople ? (
                        <Item testID="session-people-followers-people" density="compact" showDivider={false} showChevron={false}
                            icon={<FollowerMark name="users" />}
                            title={t('session.collaboration.pane.followersPeople', { count: otherPeople })}
                            subtitle={t('session.collaboration.pane.followersPeopleNote')} />
                    ) : null}
                </View>
            ) : null}
            {followEditor.editor}
            {props.session ? (
                <View ref={props.followingAnchorRef} tabIndex={-1} collapsable={false} testID="session-people-following">
                    <SessionFollowSourcesEditor destination={props.session} serverId={props.target.serverId}
                        destinationMachineId={machineId} />
                </View>
            ) : null}
        </>
    );
});


/** The sessions that follow this one, named through the batched title projection; a row opens it. */
function SessionFollowerRows(props: Readonly<{ serverId: string; followers: readonly SessionFollower[] }>) {
    const router = useRouter();
    const addresses = React.useMemo(() => props.followers.map((follower) => ({ sessionId: follower.sessionId, serverId: props.serverId })),
        [props.serverId, props.followers]);
    const titles = useSessionDisplayTitles(addresses);
    return <>
        {props.followers.map((follower, index) => {
            const preset = projectFollowPolicyEditorV1(follower.policy).preset as FollowPreset;
            return (
                <Item key={follower.sessionId} testID={`session-people-follower-session-${follower.sessionId}`}
                    density="compact" showDivider={false} title={titles[index] ?? t('session.untitled')} icon={<FollowerMark name="stack" />}
                    subtitle={joinHappierFacts(follower.manager ? t('session.collaboration.pane.followersManager') : null, describeSessionFollowLevel(preset))}
                    onPress={() => router.push(buildScopedSessionRouteHref({ sessionId: follower.sessionId, serverId: props.serverId }) as never)} />
            );
        })}
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
