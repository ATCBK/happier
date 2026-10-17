import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { formatShortRelativeTime } from '@/utils/time/formatShortRelativeTime';

import {
    summarizePluginMachines,
    type PluginMachineMatrixCellStateV1,
    type PluginMachineSummaryExceptionV1,
} from './pluginMachineMatrix';
import { usePluginMachineMatrix } from './usePluginMachineMatrix';

function stateLabel(state: PluginMachineMatrixCellStateV1): string {
    switch (state) {
        case 'installedCurrent':
            return t('settingsPlugins.machineMatrix.state.installedCurrent');
        case 'disabled':
            return t('settingsPlugins.machineMatrix.state.disabled');
        case 'untrusted':
            return t('settingsPlugins.machineMatrix.state.untrusted');
        case 'incompatible':
            return t('settingsPlugins.machineMatrix.state.incompatible');
        case 'localOnly':
            return t('settingsPlugins.machineMatrix.state.localOnly');
        case 'staleOffline':
            return t('settingsPlugins.machineMatrix.state.staleOffline');
        // The machine, not the plugin, is unavailable. Reuses the exact word
        // the Administration machine picker already gives this same fact.
        case 'machineUnavailable':
            return t('common.unavailable');
        case 'absent':
            return t('settingsPlugins.machineMatrix.state.absent');
        case 'unknown':
            return t('settingsPlugins.machineMatrix.state.unknown');
    }
}

/**
 * Never renders a live claim for a cached observation: a version is always shown as the last
 * observation, with its age, so an offline machine's prior state cannot read as current fact.
 */
function exceptionSubtitle(exception: PluginMachineSummaryExceptionV1): string | undefined {
    const parts = [exception.serverLabel ?? ''];
    if (exception.version) parts.push(`${t('common.version')} ${exception.version}`);
    const ago = typeof exception.observedAt === 'number' ? formatShortRelativeTime(exception.observedAt) : '';
    if (ago) parts.push(t('settingsPlugins.machineMatrix.lastObserved', { ago }));
    return parts.filter((part) => part.length > 0).join(' · ') || undefined;
}

/**
 * "Machines" on a plugin's page: the Account-wide answer to "where does this plugin run?", as one
 * summary ("Current on 2 of 3 machines", naming them) and then only the machines that need a look
 * (offline with a last-known version, disabled, not trusted, a different release, one that left the
 * Account). A machine that is fine, or simply doesn't have the plugin, gets no row.
 *
 * It is read-only and structurally incapable of retargeting anything: its props carry no callback,
 * its rows carry no target or execution origin and render in the non-interactive `info` mode.
 * Administration mutations stay bound to the machine chosen in the page's machine chip. The Account
 * release itself is owned by the Account release section, not repeated here.
 */
export const PluginMachineMatrixSection = React.memo(function PluginMachineMatrixSection(props: Readonly<{
    pluginId: string;
    /** The plugin ships inside Happier (bundled first-party). */
    includedWithHappier?: boolean;
    testIDPrefix?: string;
}>) {
    const { theme } = useUnistyles();
    const includedWithHappierPluginIds = React.useMemo(
        () => (props.includedWithHappier ? new Set([props.pluginId]) : undefined),
        [props.includedWithHappier, props.pluginId],
    );
    const matrix = usePluginMachineMatrix({ pluginId: props.pluginId, includedWithHappierPluginIds });
    const prefix = props.testIDPrefix ?? 'settings.plugins.machineMatrix';
    const row = matrix.kind === 'available'
        ? matrix.rows.find((candidate) => candidate.pluginId === props.pluginId) ?? null
        : null;
    const summary = row && matrix.kind === 'available' ? summarizePluginMachines(row, matrix.machineCount) : null;
    const footer = matrix.kind === 'available' && matrix.unresolvedServerCount > 0
        ? t('settingsPlugins.machineMatrix.incomplete', { count: matrix.unresolvedServerCount })
        : undefined;

    return (
        <ItemGroup
            title={t('settingsPlugins.surfaces.machinesTitle')}
            description={t('settingsPlugins.surfaces.machinesDescription')}
            {...(footer ? { footer } : {})}
        >
            {/* Shipping inside Happier is known without the Account projection, so it answers even before it loads. */}
            {row?.includedWithHappier || (matrix.kind === 'unavailable' && props.includedWithHappier) ? (
                <Item
                    testID={`${prefix}.includedWithHappier`}
                    title={t('settingsPlugins.rowSource.bundled')}
                    subtitle={t('settingsPlugins.surfaces.runsEverywhere')}
                    icon={<Icon name="check-circle" size={20} color={theme.colors.state.success.foreground} />}
                    mode="info"
                    showChevron={false}
                />
            ) : matrix.kind === 'unavailable' ? (
                <Item
                    testID={`${prefix}.unavailable`}
                    title={t('settingsPlugins.machineMatrix.unavailable')}
                    mode="info"
                    showChevron={false}
                />
            ) : summary === null || summary.total === 0 ? (
                <Item
                    testID={`${prefix}.empty`}
                    title={t('settingsPlugins.machineMatrix.empty')}
                    mode="info"
                    showChevron={false}
                />
            ) : (
                <>
                    {/*
                      * "Current on 0 of N" only reads as a fault when nothing is current but the
                      * plugin does live somewhere (a machine-bound or development source is never
                      * Account-current by construction): its machine rows already say where.
                      */}
                    {summary.currentCount === 0 && summary.exceptions.length > 0 ? null : (
                    <Item
                        testID={`${prefix}.summary`}
                        title={t('settingsPlugins.surfaces.machinesCurrent', {
                            current: summary.currentCount,
                            total: summary.total,
                        })}
                        subtitle={summary.currentNames.length > 0 ? summary.currentNames.join(', ') : undefined}
                        icon={summary.currentCount > 0
                            ? <Icon name="check-circle" size={20} color={theme.colors.state.success.foreground} />
                            : undefined}
                        mode="info"
                        showChevron={false}
                    />
                    )}
                    {summary.exceptions.map((exception) => {
                        const name = exception.name ?? t('settingsPlugins.surfaces.machinesRetained');
                        const subtitle = exceptionSubtitle(exception);
                        return (
                            <Item
                                key={exception.machineKey}
                                testID={`${prefix}.exception`}
                                title={name}
                                subtitle={subtitle}
                                detail={stateLabel(exception.state)}
                                accessibilityLabel={[`${name}: ${stateLabel(exception.state)}`, subtitle]
                                    .filter(Boolean).join('. ')}
                                mode="info"
                                showChevron={false}
                            />
                        );
                    })}
                </>
            )}
        </ItemGroup>
    );
});
