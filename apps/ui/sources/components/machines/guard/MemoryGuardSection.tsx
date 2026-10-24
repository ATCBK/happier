import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MachineGuardPolicyPatchV1, MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardViewV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';

import { TextLinkButton } from '@/components/ui/buttons/TextLinkButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import { GuardLadder, GuardLadderReserved } from './GuardLadder';
import {
    MEMORY_COOLDOWN_PRESETS_MS, MEMORY_SUSTAIN_PRESETS_MS, PAUSE_FOR_MS, describeMemoryGuardRow, formatGuardDuration,
    guardLevelWord, parseCustomGuardMinutes, resolveMemoryGuardRowState,
} from './guardPresentation';
import { GuardChoiceRow, GuardSelectRow, GuardSwitchRow, ReadOnlyValue } from './guardRows';
import type { GuardRowId } from './useGuardPolicy';

/**
 * Memory guard (lab `rg` G1 / G2 / G8 / G9-1): one switch saying what the guard is doing; when on, the
 * level, how long it must last and the wait between steps; then the ladder — what Happier would do
 * right now with the real candidates, or what it is doing in an episode. No pressure signal: the row
 * says so and the ladder is not drawn.
 */
export const MemoryGuardSection = React.memo(function MemoryGuardSection(props: Readonly<{
    machineName: string;
    policy: MachineGuardPolicyV1;
    view: MachineGuardViewV1 | null;
    editable: boolean;
    failed: ReadonlySet<GuardRowId>;
    /** A saved value the machine hasn't applied yet. */
    awaiting: (row: GuardRowId) => string | null;
    /** The machine's first answer is still on its way (not offline, not failed): the ladder stands reserved. */
    reading: boolean;
    nowMs: number;
    save: (row: GuardRowId, patch: MachineGuardPolicyPatchV1) => void;
}>) {
    const { policy, view, save, editable } = props;
    const state = view?.state ?? null;
    const row = state ? resolveMemoryGuardRowState(policy, state, props.nowMs) : (policy.memoryGuard.enabled ? { kind: 'on_unread' as const } : { kind: 'off' as const });
    const failure = (id: GuardRowId) => props.failed.has(id) ? t('machineGuard.saveFailed', { machine: props.machineName }) : null;
    const guard = policy.memoryGuard;
    const minutes = (value: number) => ({ title: t('machineGuard.memory.customMinutes.title'), body: t('machineGuard.memory.customMinutes.body'),
        invalid: t('machineGuard.memory.customMinutes.invalid'), defaultValue: `${value / 60_000} min`, parse: parseCustomGuardMinutes });
    const pauseLink = row.kind === 'paused'
        ? <TextLinkButton testID="machine-guard-memory-resume" tone="strong" label={t('machineGuard.memory.resumeNow')} disabled={!editable}
            onPress={() => save('memory', { memoryGuard: { pausedUntil: null } })} />
        : row.kind === 'acting' || row.kind === 'sustaining' || row.kind === 'out_of_steps'
            ? <TextLinkButton testID="machine-guard-memory-pause" label={t('machineGuard.memory.pauseHour')} disabled={!editable}
                onPress={() => save('memory', { memoryGuard: { pausedUntil: Date.now() + PAUSE_FOR_MS } })} />
            : null;
    const previewLead = guard.enabled ? t('machineGuard.ladder.preview', { machine: props.machineName })
        : t('machineGuard.ladder.previewOff', { machine: props.machineName });
    const ladderLead = !view ? null : row.kind === 'acting' && state?.episode
        ? t('machineGuard.ladder.acting', { machine: props.machineName, level: guardLevelWord(guard.actAt),
            since: formatGuardDuration(Math.max(60_000, props.nowMs - state.episode.since)) })
        : row.kind === 'out_of_steps' ? t('machineGuard.ladder.outOfSteps', { machine: props.machineName })
            : previewLead;
    return (
        <ItemGroup title={t('machineGuard.memory.title')} description={t('machineGuard.memory.description', { machine: props.machineName })}>
            {row.kind === 'unavailable' ? (
                <Item testID="machine-guard-memory" title={t('machineGuard.memory.switchTitle', { machine: props.machineName })}
                    subtitle={describeMemoryGuardRow(row, policy, props.machineName)} mode="info"
                    rightElement={<ReadOnlyValue quiet text={t('machineGuard.unavailable')} />} />
            ) : (
                <GuardSwitchRow testID="machine-guard-memory" title={t('machineGuard.memory.switchTitle', { machine: props.machineName })}
                    subtitle={describeMemoryGuardRow(row, policy, props.machineName)} value={guard.enabled}
                    editable={editable} failed={failure('memory')} awaiting={props.awaiting('memory')}
                    onToggle={enabled => save('memory', { memoryGuard: { enabled } })}
                    bottomElement={pauseLink ? <View style={styles.inlineAction}>{pauseLink}</View> : undefined} />
            )}
            {row.kind !== 'unavailable' && guard.enabled ? (
                <GuardChoiceRow testID="machine-guard-level" title={t('machineGuard.memory.levelTitle')}
                    value={guard.actAt} editable={editable} failed={failure('level')} awaiting={props.awaiting('level')}
                    options={[
                        { id: 'elevated', label: t('machineGuard.memory.levelElevated'), description: t('machineGuard.memory.levelElevatedHelp') },
                        { id: 'critical', label: t('machineGuard.memory.levelCritical'), description: t('machineGuard.memory.levelCriticalHelp') },
                    ]}
                    onChange={actAt => save('level', { memoryGuard: { actAt } })} />
            ) : null}
            {row.kind !== 'unavailable' && guard.enabled ? (
                <GuardSelectRow testID="machine-guard-sustain" title={t('machineGuard.memory.sustainTitle')} subtitle={t('machineGuard.memory.sustainHelp')}
                    label={t('machineGuard.memory.sustainTitle')} value={guard.sustainMs} format={formatGuardDuration} presets={MEMORY_SUSTAIN_PRESETS_MS}
                    custom={minutes(guard.sustainMs)} editable={editable} failed={failure('sustain')} awaiting={props.awaiting('sustain')}
                    onChange={sustainMs => save('sustain', { memoryGuard: { sustainMs } })} />
            ) : null}
            {row.kind !== 'unavailable' && guard.enabled ? (
                <GuardSelectRow testID="machine-guard-cooldown" title={t('machineGuard.memory.cooldownTitle')} subtitle={t('machineGuard.memory.cooldownHelp')}
                    label={t('machineGuard.memory.cooldownTitle')} value={guard.cooldownMs} format={formatGuardDuration} presets={MEMORY_COOLDOWN_PRESETS_MS}
                    custom={minutes(guard.cooldownMs)} editable={editable} failed={failure('cooldown')} awaiting={props.awaiting('cooldown')}
                    onChange={cooldownMs => save('cooldown', { memoryGuard: { cooldownMs } })} />
            ) : null}
            {row.kind !== 'unavailable' && view && ladderLead ? (
                <GuardLadder ladder={view.ladder} othersWorkCount={view.othersWorkCount}
                    lead={<Emphasized text={ladderLead} word={props.machineName} />}
                    stepSwitches={guard.enabled && (editable || props.failed.has('steps')) ? {
                        editable,
                        onToggle: (rung, enabled) => save('steps', { memoryGuard: { steps: rung === 'browsers' ? { browsers: enabled }
                            : rung === 'devServers' ? { devServers: enabled } : { idleSessions: enabled } } }),
                    } : null} />
            ) : null}
            {row.kind !== 'unavailable' && !view && props.reading ? (
                <GuardLadderReserved lead={<Emphasized text={previewLead} word={props.machineName} />} />
            ) : null}
        </ItemGroup>
    );
});

/** A sentence with its one name in bold ("If **leeroy-mbp** ran short on memory right now…"). */
export function Emphasized(props: Readonly<{ text: string; word: string }>) {
    const at = props.word ? props.text.indexOf(props.word) : -1;
    if (at < 0) return <>{props.text}</>;
    return (
        <>
            {props.text.slice(0, at)}
            <Text style={styles.strong}>{props.word}</Text>
            {props.text.slice(at + props.word.length)}
        </>
    );
}

const styles = StyleSheet.create((theme) => ({
    inlineAction: {
        paddingTop: theme.space.s6,
        alignItems: 'flex-start',
    },
    strong: {
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
}));
