import * as React from 'react';
import { projectAccountSessionFollowEditorStateV1, type PersonalFollowOnceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { SetSessionFollowRequest } from '@happier-dev/protocol/sessions/follow/api';
import type { FollowPolicyEditorEditV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';

import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionButtonRow } from '@/components/ui/lists/SectionButtonRow';
import { t } from '@/text';

import { FollowPolicyEditorBinding, FollowPolicySection } from './FollowPolicyEditorBinding';
import { projectAccountSessionFollowPolicyEditor, type AccountSessionFollowEditorSnapshot } from './accountSessionFollowController';
import type { AccountVoiceFollowReadiness } from './accountVoiceFollowReadiness';

/** What the editor hands its host: the header's words and mark, the scrolling body and the fixed footer. */
export type AccountSessionFollowEditorParts = Readonly<{
    title: string;
    subtitle: string;
    mark: React.ReactNode;
    body: React.ReactNode;
    footer: React.ReactNode;
}>;

export type AccountSessionFollowEditorProps = Readonly<{
    state: AccountSessionFollowEditorSnapshot;
    /** One policy edit, applied by the controller's existing writer. */
    onEditPolicy(edit: FollowPolicyEditorEditV1): void;
    voiceReadiness: AccountVoiceFollowReadiness;
    archived: boolean;
    /**
     * A linked external Session whose Background sync is off. Following it still
     * works, but Happier only sees the external source while that Session is
     * attached, so the editor says so instead of promising delivery.
     */
    externalBackgroundSyncOff?: boolean;
    onSet(preferences: SetSessionFollowRequest): void;
    onRemove(): void;
    onRetry(): void;
    onOpenNotificationSettings(): void;
    /**
     * One-shot "Notify me once", on top of the level and then it ends. `sourceTurnId` is the turn in
     * progress (null when none, so "When this turn ends" is not offered). Absent where it cannot apply.
     */
    notifyOnce?: Readonly<{
        sourceTurnId: string | null;
        onOnce(once: PersonalFollowOnceV1 | null): Promise<void> | void;
    }>;
    /** The followed Session's name and identity mark, for the header ("Follow <session>"). */
    sessionTitle?: string;
    sessionMark?: React.ReactNode;
    /** Done: the host closes the popover or leaves the page. */
    onClose?(): void;
    /** Who else follows it (you excluded); null while unknown, so nothing is claimed. */
    alsoFollowing?: Readonly<{ people: number; sessions: number }> | null;
    onOpenPeople?(): void;
    /** The quiet-hours window in effect ("22:00–07:00"), `on` when it has several, null when off. */
    quietHours?: string | null;
    /** Places the parts: a popover panel or a page. Absent, they are stacked in place. */
    frame?(parts: AccountSessionFollowEditorParts): React.ReactNode;
}>;

/**
 * The one personal Follow editor (lab P2-A): "Follow <session>" and how much you hear about it, the
 * shared level editor and what each level means, Voice and Notify me once, quiet hours and who else
 * follows it, then Unfollow · Done. The popover and the phone page place the same parts.
 */
export function AccountSessionFollowEditor(props: AccountSessionFollowEditorProps) {
    const { state } = props;
    const isSessionOwner = state.projection?.isSessionOwner === true;
    // Effective state, not the raw row: a Session owner with no stored choice is
    // permanently tracked and Important-eligible at the Home.
    const effective = state.projection
        ? projectAccountSessionFollowEditorStateV1({ follow: state.projection.follow, isSessionOwner })
        : null;
    // The same canonical projection the controller hook exposes, read from this editor's snapshot.
    const editorState = React.useMemo(() => projectAccountSessionFollowPolicyEditor(state), [state]);
    const policyModel = editorState.model;
    const deliveryEnabled = editorState.deliveryEnabled;
    // Voice is read from the canonical editor projection and written as a policy edit.
    const includeInVoice = state.draft?.includeInVoice ?? effective?.includeInVoice ?? false;
    const canManage = state.projection?.capabilities.manageFollow === true;
    const canEdit = canManage && !props.archived;
    const disabled = !state.online || state.saving || !canEdit;
    // Nothing is claimed before the first read: an owner is tracked, so "Follow" would be false.
    const pending = state.loading && !state.projection;
    const voiceReadiness = props.voiceReadiness;
    // `eligible` is the nominal case the row subtitle already describes, so it has
    // no status line: repeating that sentence directly beneath itself would spend a
    // row saying nothing new.
    const voiceDeliveryTitle = voiceReadiness === 'waiting_for_runtime'
        ? t('session.follow.voice.waitingRuntime')
        : voiceReadiness === 'waiting_encrypted'
            ? t('session.follow.voice.waitingEncrypted')
            : voiceReadiness === 'runtime_unsupported'
                ? t('session.follow.voice.unsupported')
                : voiceReadiness === 'provider_withheld'
                    ? t('session.follow.voice.providerWithheld')
                    : voiceReadiness === 'pending'
                        ? t('session.follow.voice.initialSnapshotPending')
                        : null;
    const error = state.error === 'session_not_found'
        ? t('session.follow.accessLost')
        : state.error === 'credential_scope_denied'
            ? t('errors.permissionDenied')
            : state.error === 'session_archived'
                ? t('session.follow.archived')
                : state.error === 'feature_unavailable' || state.error === 'account_inactive'
                    ? t('common.unavailable')
                    : t('errors.unknownError');

    const onceRow = props.notifyOnce && state.projection && !props.archived
        ? <NotifyOnceRow once={state.projection.follow?.once ?? null} disabled={disabled} {...props.notifyOnce} />
        : null;
    const policyEditor = policyModel
        ? <FollowPolicyEditorBinding testID="session-follow-policy" model={policyModel} disabled={disabled} onEditPolicy={props.onEditPolicy} />
        : null;
    const also = props.alsoFollowing;
    const alsoCount = also ? also.people + also.sessions : 0;

    const body = <>
        {pending ? <ItemGroup>
            <Item title={t('common.loading')} loading showChevron={false} mode="info" />
        </ItemGroup> : null}
        {!state.online || state.error ? <ItemGroup>
            <Item
                testID="session-follow-error"
                title={!state.online ? t('session.follow.offline') : error}
                mode="info"
                titleLines={0}
                accessibilityLiveRegion="polite"
                showChevron={false}
            />
            {state.online ? <Item testID="session-follow-retry" title={t('common.retry')} onPress={props.onRetry} showChevron={false} /> : null}
        </ItemGroup> : null}
        {props.archived && !pending ? <ItemGroup surface="none">
            <Item testID="session-follow-archived" title={t('session.follow.archived')} mode="info" titleLines={0} showChevron={false} />
        </ItemGroup> : null}
        {policyModel ? <>
            <FollowPolicySection>{policyEditor}</FollowPolicySection>
            <ItemGroup>
                <Item
                    title={t('session.follow.voice.title')}
                    subtitle={t('session.follow.voice.subtitle')}
                    titleLines={0}
                    showChevron={false}
                    rightElement={<Switch
                        testID="session-follow-voice"
                        value={includeInVoice}
                        disabled={disabled}
                        onValueChange={(enabled) => props.onEditPolicy({ kind: 'voice', enabled })}
                    />}
                />
                {includeInVoice && voiceDeliveryTitle ? <Item
                    testID="session-follow-voice-delivery"
                    title={voiceDeliveryTitle}
                    mode="info"
                    titleLines={0}
                    accessibilityLiveRegion="polite"
                /> : null}
                {onceRow}
            </ItemGroup>
            {props.externalBackgroundSyncOff ? <ItemGroup surface="none">
                <Item
                    testID="session-follow-external-attached-only"
                    title={t('session.follow.editor.externalAttachedOnly')}
                    mode="info"
                    titleLines={0}
                    showChevron={false}
                />
            </ItemGroup> : null}
        </> : null}
        {!policyModel && state.projection && !props.archived ? <>
            <ItemGroup surface="none">
                <Item testID="session-follow-not-following" title={isSessionOwner ? t('session.follow.editor.suppressed') : t('session.follow.editor.notFollowing')}
                    mode="info" titleLines={0} showChevron={false} />
            </ItemGroup>
            {onceRow ? <ItemGroup>{onceRow}</ItemGroup> : null}
        </> : null}
        {/* Quiet facts that change what reaches you, each leading where it is changed. */}
        <ItemGroup surface="none">
            <Item
                testID="session-follow-quiet-hours"
                density="compact"
                showDivider={false}
                icon={<Icon name={props.quietHours ? 'moon' : 'bell'} />}
                title={props.quietHours === 'on' ? t('session.follow.editor.quietHoursOn')
                    : props.quietHours ? t('session.follow.editor.quietHours', { range: props.quietHours })
                        : t('session.follow.settingsLink')}
                titleLines={0}
                onPress={props.onOpenNotificationSettings}
            />
            {alsoCount > 0 && also && props.onOpenPeople ? <Item
                testID="session-follow-people"
                density="compact"
                showDivider={false}
                icon={<Icon name="users" />}
                title={t('session.follow.editor.alsoFollow', {
                    facts: joinHappierFacts(
                        also.people > 0 ? t('session.collaboration.pane.followersPeople', { count: also.people }) : null,
                        also.sessions > 0 ? t('session.collaboration.pane.followersSessions', { count: also.sessions }) : null,
                    ),
                    count: alsoCount,
                })}
                titleLines={0}
                detail={t('session.follow.editor.people')}
                onPress={props.onOpenPeople}
            /> : null}
        </ItemGroup>
    </>;

    // Owner tracking survives suppression, but the delivery choice is editable in both states.
    // Nothing is offered before the first read.
    const footer = pending ? null : <SectionButtonRow
        trailing={!deliveryEnabled ? <RoundButton
            testID="session-follow-follow"
            title={t('session.follow.follow')}
            disabled={!state.online || state.saving || !state.projection || !canManage || props.archived}
            onPress={() => {
                if (props.archived) return;
                props.onSet({ notificationLevel: 'important', includeInVoice: false });
            }}
        /> : <RoundButton testID="session-follow-done" title={t('common.done')} onPress={() => props.onClose?.()} />}
    >
        {deliveryEnabled ? <RoundButton
                testID="session-follow-unfollow"
                display="inverted"
                // An owner stays tracked, so what it can do is turn delivery off.
                title={isSessionOwner ? t('session.follow.editor.turnOff') : t('session.follow.unfollow')}
                disabled={!state.online || state.saving || !canManage}
                onPress={props.onRemove}
            /> : null}
    </SectionButtonRow>;

    const parts: AccountSessionFollowEditorParts = {
        title: props.sessionTitle ? t('session.follow.editor.sheetTitle', { name: props.sessionTitle }) : t('session.follow.editor.title'),
        subtitle: t('session.follow.editor.sheetSubtitle'),
        mark: props.sessionMark ?? null,
        body,
        footer,
    };
    return <>{props.frame ? props.frame(parts) : <>{parts.body}{parts.footer}</>}</>;
}

type OnceChoice = 'off' | 'turn' | 'attention';

/** One field select: Off, When this turn ends (only while a turn runs), When it next needs you. */
function NotifyOnceRow(props: Readonly<{
    once: PersonalFollowOnceV1 | null;
    sourceTurnId: string | null;
    disabled: boolean;
    onOnce(once: PersonalFollowOnceV1 | null): Promise<void> | void;
}>) {
    const [open, setOpen] = React.useState(false);
    const selected: OnceChoice = props.once?.kind === 'turn_finished' ? 'turn' : props.once?.kind === 'first_needs_you' ? 'attention' : 'off';
    const items: DropdownMenuItem[] = [
        { id: 'off', title: t('session.follow.once.off') },
        ...(props.sourceTurnId !== null || selected === 'turn' ? [{ id: 'turn', title: t('session.follow.once.turn') }] : []),
        { id: 'attention', title: t('session.follow.once.attention') },
    ];
    const titles: Record<OnceChoice, string> = {
        off: t('session.follow.once.off'), turn: t('session.follow.once.turn'), attention: t('session.follow.once.attention'),
    };
    return <DropdownMenu
        testID="session-follow-once"
        open={open}
        onOpenChange={(next) => setOpen(next && !props.disabled)}
        variant="selectable"
        search={false}
        selectedId={selected}
        showCategoryTitles={false}
        matchTriggerWidth={false}
        connectToTrigger
        rowKind="item"
        itemTrigger={{
            title: t('session.follow.once.title'),
            subtitle: t('session.follow.once.subtitle'),
            showSelectedSubtitle: false,
            detailFormatter: () => titles[selected],
            itemProps: { subtitleLines: 0, disabled: props.disabled },
        }}
        items={items}
        onSelect={(id) => {
            setOpen(false);
            if (id === selected) return;
            if (id === 'turn' && props.sourceTurnId === null) return;
            void props.onOnce(id === 'turn' ? { kind: 'turn_finished', sourceTurnId: props.sourceTurnId! }
                : id === 'attention' ? { kind: 'first_needs_you' } : null);
        }}
    />;
}
