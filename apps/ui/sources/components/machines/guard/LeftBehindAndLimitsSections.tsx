import * as React from 'react';
import type { MachineGuardPolicyPatchV1, MachineGuardPolicyV1 } from '@happier-dev/protocol/machines/guard/guardPolicyV1';
import type { MachineGuardViewV1 } from '@happier-dev/protocol/machines/guard/guardRpcV1';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

import {
    CEILING_PRESET_BYTES, CEILING_WARN_PRESETS, LEFT_BEHIND_GRACE_PRESETS_MS, describeCeilingUnavailable, describeLeftBehindRow,
    formatGuardCeiling, formatGuardGrace, parseCustomCeilingBytes, parseCustomGuardGrace, parseCustomWarnPercent,
} from './guardPresentation';
import { GuardChoiceRow, GuardSelectRow, ReadOnlyValue } from './guardRows';
import type { GuardRowId } from './useGuardPolicy';

type Failure = (row: GuardRowId) => string | null;
type Save = (row: GuardRowId, patch: MachineGuardPolicyPatchV1) => void;

/**
 * Left-behind processes (lab `rg` G1 / G4): Off · Ask · Automatic, saying what is running now while
 * off, and the grace after a session ends when automatic (R39).
 */
export const LeftBehindSection = React.memo(function LeftBehindSection(props: Readonly<{
    machineName: string;
    rule: MachineGuardPolicyV1['leftBehind'];
    present: MachineGuardViewV1['leftBehind'] | null;
    editable: boolean;
    failure: Failure;
    /** A saved value the machine hasn't applied yet. */
    awaiting: Failure;
    save: Save;
}>) {
    const { rule, save, editable, failure, awaiting } = props;
    return (
        <ItemGroup title={t('machineGuard.leftBehind.title')} description={t('machineGuard.leftBehind.description')}>
            <GuardChoiceRow testID="machine-guard-left-behind" title={t('machineGuard.leftBehind.modeTitle')}
                subtitle={describeLeftBehindRow(rule, props.present, props.machineName)}
                value={rule.mode} editable={editable} failed={failure('leftBehind')} awaiting={awaiting('leftBehind')}
                options={[
                    { id: 'off', label: t('machineGuard.leftBehind.off') },
                    { id: 'ask', label: t('machineGuard.leftBehind.ask') },
                    { id: 'automatic', label: t('machineGuard.leftBehind.automatic') },
                ]}
                onChange={mode => save('leftBehind', { leftBehind: { mode } })} />
            {rule.mode === 'automatic' ? (
                <GuardSelectRow testID="machine-guard-grace" title={t('machineGuard.leftBehind.graceTitle')} subtitle={t('machineGuard.leftBehind.graceHelp')}
                    label={t('machineGuard.leftBehind.graceTitle')} value={rule.graceMs} format={formatGuardGrace} presets={LEFT_BEHIND_GRACE_PRESETS_MS}
                    custom={{ title: t('machineGuard.leftBehind.customGrace.title'), body: t('machineGuard.leftBehind.customGrace.body'),
                        invalid: t('machineGuard.leftBehind.customGrace.invalid'), defaultValue: `${rule.graceMs / 1000} s`, parse: parseCustomGuardGrace }}
                    editable={editable} failed={failure('grace')} awaiting={awaiting('grace')} onChange={graceMs => save('grace', { leftBehind: { graceMs } })} />
            ) : null}
        </ItemGroup>
    );
});

/**
 * Limits and power (lab `rg` G1 / G5): the memory ceiling per session — unavailable, with the reason,
 * where the OS cannot cap a session with its processes — its warning share (R39), and keeping the
 * machine reachable while Happier runs (Off · On · On power, default On).
 */
export const LimitsAndPowerSection = React.memo(function LimitsAndPowerSection(props: Readonly<{
    machineName: string;
    platform: string | undefined;
    policy: MachineGuardPolicyV1;
    state: MachineGuardViewV1['state'] | null;
    keepAwake: MachineGuardViewV1['keepAwake'] | null;
    editable: boolean;
    failure: Failure;
    /** A saved value the machine hasn't applied yet. */
    awaiting: Failure;
    save: Save;
}>) {
    const { policy, save, editable, failure, awaiting, state } = props;
    const ceiling = policy.sessionMemoryCeiling;
    const ceilingCapability = state?.capabilities.ceiling ?? null;
    const awake = state?.capabilities.keepAwake ?? null;
    const modes = awake?.modes ?? ['off', 'on', 'on_power'];
    const awakeHelp = policy.keepAwake === 'off' ? t('machineGuard.limits.awakeOff')
        : policy.keepAwake === 'on_power' ? t('machineGuard.limits.awakeOnPower') : t('machineGuard.limits.awakeOn');
    const awakeUnavailable = awake?.unavailableReason === 'no_inhibitor' ? t('machineGuard.limits.awakeNoInhibitor')
        : awake?.unavailableReason === 'helper_missing' ? t('machineGuard.limits.awakeHelperMissing') : null;
    const holding = props.keepAwake?.holding
        ? props.keepAwake.workingSessions > 0
            ? t('machineGuard.limits.awakeHolding', { count: props.keepAwake.workingSessions })
            : t('machineGuard.limits.awakeHoldingIdle')
        : null;
    const lidHelp = props.platform === 'darwin' ? t('machineGuard.limits.awakeLidMac')
        : props.platform === 'linux' || props.platform === 'win32' ? t('machineGuard.limits.awakeLidSettings') : null;
    return (
        <ItemGroup title={t('machineGuard.limits.title')}>
            {ceilingCapability?.status === 'unavailable' ? (
                <Item testID="machine-guard-ceiling" title={t('machineGuard.limits.ceilingTitle')} mode="info"
                    subtitle={describeCeilingUnavailable(ceilingCapability.reason, props.platform)}
                    rightElement={<ReadOnlyValue quiet text={t('machineGuard.unavailable')} />} />
            ) : (
                <GuardSelectRow<number | null> testID="machine-guard-ceiling" title={t('machineGuard.limits.ceilingTitle')} subtitle={t('machineGuard.limits.ceilingHelp')}
                    label={t('machineGuard.limits.ceilingLabel')} value={ceiling.bytes} format={formatGuardCeiling} presets={[null, ...CEILING_PRESET_BYTES]}
                    custom={{ title: t('machineGuard.limits.customCeiling.title'), body: t('machineGuard.limits.customCeiling.body'),
                        invalid: t('machineGuard.limits.customCeiling.invalid'), defaultValue: ceiling.bytes === null ? '' : formatGuardCeiling(ceiling.bytes), parse: parseCustomCeilingBytes }}
                    editable={editable && ceilingCapability !== null} failed={failure('ceiling')} awaiting={awaiting('ceiling')}
                    onChange={bytes => save('ceiling', { sessionMemoryCeiling: { bytes } })} />
            )}
            {ceilingCapability?.status !== 'unavailable' && ceiling.bytes !== null ? (
                <GuardSelectRow testID="machine-guard-ceiling-warn" title={t('machineGuard.limits.warnTitle')} subtitle={t('machineGuard.limits.warnHelp')}
                    label={t('machineGuard.limits.warnTitle')} value={ceiling.warnAtPercent} format={percent => t('machineGuard.limits.percent', { percent })}
                    presets={CEILING_WARN_PRESETS}
                    custom={{ title: t('machineGuard.limits.customPercent.title'), body: t('machineGuard.limits.customPercent.body'),
                        invalid: t('machineGuard.limits.customPercent.invalid'), defaultValue: String(ceiling.warnAtPercent), parse: parseCustomWarnPercent }}
                    editable={editable} failed={failure('ceilingWarn')} awaiting={awaiting('ceilingWarn')} onChange={warnAtPercent => save('ceilingWarn', { sessionMemoryCeiling: { warnAtPercent } })} />
            ) : null}
            {awakeUnavailable !== null ? (
                <Item testID="machine-guard-awake" title={t('machineGuard.limits.awakeTitle', { machine: props.machineName })} mode="info"
                    subtitle={awakeUnavailable} rightElement={<ReadOnlyValue quiet text={t('machineGuard.unavailable')} />} />
            ) : (
                <GuardChoiceRow testID="machine-guard-awake" title={t('machineGuard.limits.awakeTitle', { machine: props.machineName })}
                    subtitle={[awakeHelp, holding, lidHelp].filter(Boolean).join(' ')}
                    value={policy.keepAwake} editable={editable} failed={failure('awake')} awaiting={awaiting('awake')}
                    options={[
                        { id: 'off' as const, label: t('machineGuard.off') },
                        ...(modes.includes('on') ? [{ id: 'on' as const, label: t('machineGuard.limits.awakeOnLabel') }] : []),
                        ...(modes.includes('on_power') ? [{ id: 'on_power' as const, label: t('machineGuard.limits.awakeOnPowerLabel') }] : []),
                    ]}
                    onChange={keepAwake => save('awake', { keepAwake })} />
            )}
        </ItemGroup>
    );
});
