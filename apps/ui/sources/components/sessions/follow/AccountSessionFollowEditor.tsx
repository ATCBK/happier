import * as React from 'react';
import { projectAccountSessionFollowEditorStateV1, type PersonalFollowOnceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import type { SetSessionFollowRequest } from '@happier-dev/protocol/sessions/follow/api';
import type { FollowPolicyEditorEditV1 } from '@happier-dev/protocol/sessions/follow/followPolicyEditorV1';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Switch } from '@/components/ui/forms/Switch';
import { Item } from '@/components/ui/lists/Item';
import { CoreCollectionScope } from '@/components/ui/lists/collection/CoreCollectionScope';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import { FollowPolicyEditorBinding } from './FollowPolicyEditorBinding';
import { projectAccountSessionFollowPolicyEditor, type AccountSessionFollowEditorSnapshot } from './accountSessionFollowController';
import type { AccountVoiceFollowReadiness } from './accountVoiceFollowReadiness';

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
}>;

export function AccountSessionFollowEditor(props: AccountSessionFollowEditorProps) {
    const { state } = props;
    const isSessionOwner = state.projection?.isSessionOwner === true;
    // Effective state, not the raw row: a Session owner with no stored choice is
    // permanently tracked and Important-eligible at the Home.
    const effective = state.projection
        ? projectAccountSessionFollowEditorStateV1({ follow: state.projection.follow, isSessionOwner })
        : null;
    const following = effective?.tracked === true;
    // The same canonical projection the controller hook exposes, read from this editor's snapshot.
    const policyModel = React.useMemo(() => projectAccountSessionFollowPolicyEditor(state).model, [state]);
    // Voice is read from the canonical editor projection and written as a policy edit.
    const includeInVoice = state.draft?.includeInVoice ?? effective?.includeInVoice ?? false;
    const canManage = state.projection?.capabilities.manageFollow === true;
    const canEdit = canManage && !props.archived;
    const disabled = !state.online || state.saving || !canEdit;
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

    return <>
        {/* Nothing is claimed before the first read: an owner is tracked, so an Off switch would be false. */}
        {state.loading && !state.projection ? null : <ItemGroup description={t('session.follow.footer')}>
            {isSessionOwner ? <Item
                testID="session-follow-owner-row"
                title={t('session.follow.following')}
                subtitle={props.archived ? t('session.follow.archived') : t('session.follow.editor.ownerSubtitle')}
                titleLines={0}
                showChevron={false}
                mode="info"
            /> : <Item
                testID="session-follow-enabled-row"
                title={t('session.follow.editor.title')}
                subtitle={props.archived ? t('session.follow.archived') : t('session.follow.editor.subtitle')}
                titleLines={0}
                showChevron={false}
                rightElement={<Switch
                    testID="session-follow-enabled"
                    value={following}
                    disabled={!state.online || state.saving || !state.projection || !canManage || (props.archived && !following)}
                    onValueChange={(enabled) => {
                        if (props.archived && enabled) return;
                        if (enabled) props.onSet({ notificationLevel: 'important', includeInVoice: false });
                        else props.onRemove();
                    }}
                />}
            />}
        </ItemGroup>}
        {state.loading && !state.projection ? <ItemGroup>
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
        {following && policyModel ? <>
            {/* The scope sits outside the bare section, so the public sections take the column's own inset once. */}
            <CoreCollectionScope>
                <ItemGroup surface="none">
                    <FollowPolicyEditorBinding testID="session-follow-policy" model={policyModel} disabled={disabled} onEditPolicy={props.onEditPolicy} />
                </ItemGroup>
            </CoreCollectionScope>
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
            {props.externalBackgroundSyncOff ? <ItemGroup>
                <Item
                    testID="session-follow-external-attached-only"
                    title={t('session.follow.editor.externalAttachedOnly')}
                    mode="info"
                    titleLines={0}
                    showChevron={false}
                />
            </ItemGroup> : null}
        </> : null}
        {!following && onceRow ? <ItemGroup>{onceRow}</ItemGroup> : null}
        <ItemGroup>
            <Item title={t('session.follow.settingsLink')} onPress={props.onOpenNotificationSettings} />
        </ItemGroup>
    </>;
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
