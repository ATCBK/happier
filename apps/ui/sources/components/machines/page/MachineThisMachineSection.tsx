import * as React from 'react';
import { View } from 'react-native';

import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readCachedMachineDoctorSnapshot } from '@/components/machines/doctorSnapshot/machineDoctorSnapshotCache';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { useMachineDirectConnectionSummary } from '@/components/settings/connections/DirectConnectionSettings';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSettings } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';

import { useMachinesDoor } from './machinesDoor';
import { MACHINE_THIS_MACHINE_PAGES, MACHINE_SUB_PAGE_TITLE_KEYS, type MachineThisMachinePageId } from './machineSubPages';

const ROW_ICONS: Readonly<Record<MachineThisMachinePageId, IconName>> = {
    work: 'folder',
    sharing: 'users',
    agents: 'sparkle',
    terminal: 'terminal',
    connection: 'arrows-left-right',
    installables: 'cube',
    doctor: 'first-aid-kit',
    details: 'info',
};

/** "Claude and Codex are ready": the agents the last inventory read found ready, from what the app holds. */
export function describeMachineAgentsReady(titles: readonly string[]): string | null {
    if (titles.length === 0) return null;
    if (titles.length === 1) return t('machineDetailPage.summaries.agentReady', { agent: titles[0]! });
    if (titles.length === 2) return t('machineDetailPage.summaries.agentsReadyPair', { first: titles[0]!, second: titles[1]! });
    return t('machineDetailPage.summaries.agentsReadyCount', { count: titles.length });
}

/** Sharing's row says who it is shared with from what the machine record holds: a machine shared with you names its owner. */
export function describeMachineSharingSummary(machine: Readonly<{ isShared?: boolean; access?: Readonly<{ custodian: Readonly<{ displayName?: string | null }> }> | null }>): string | undefined {
    if (machine.isShared) {
        const owner = machine.access?.custodian.displayName?.trim();
        return owner ? t('machineDetailPage.summaries.sharedByOwner', { owner }) : t('machineDetailPage.summaries.sharedWithYou');
    }
    return undefined;
}

/** "Checked <time>" from the persisted last Doctor snapshot; a machine never checked has no summary. */
export function describeMachineDoctorSummary(snapshot: Readonly<{ cachedAt: number }> | null): string | undefined {
    if (!snapshot) return undefined;
    return t('machineDetailPage.summaries.doctorChecked', { time: new Date(snapshot.cachedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) });
}

/** The terminal multiplexer new sessions on this machine open in, by its own name. */
export function describeMachineTerminalHost(host: ReturnType<typeof resolveTerminalHost>): string {
    if (host === 'tmux') return 'tmux';
    if (host === 'zellij') return 'Zellij';
    if (host === 'herdr') return 'Herdr';
    return t('machineDetailPage.summaries.terminalDirect');
}

/**
 * "This machine" (lab `R`, `DD`): the machine's own settings and diagnostics, one row each, every row
 * a pushed sub-page in the door the page was opened through. Each summary line is a fact the section's owner
 * already holds; a row with none is its title alone, so the Overview never asks the machine for something only a
 * sub-page shows.
 */
export const MachineThisMachineSection = React.memo(function MachineThisMachineSection(props: Readonly<{
    serverId: string;
    machine: Machine;
}>) {
    const language = usePreferredLanguage();
    const router = useRouter();
    const door = useMachinesDoor();
    const machineId = props.machine.id;
    const agents = useMachineAgents({ serverId: props.serverId, machineId, load: false });
    const settings = useSettings();
    const terminalHost = resolveTerminalHost({ settings, machineId });
    const connection = useMachineDirectConnectionSummary(machineId);
    const doctor = React.useMemo(() => readCachedMachineDoctorSnapshot({ serverId: props.serverId, machineId }), [machineId, props.serverId]);
    const agentsReady = React.useMemo(
        () => describeMachineAgentsReady(agents.agents.filter((agent) => agent.state === 'ready' || agent.state === 'updateAvailable').map((agent) => agent.title)),
        [language, agents.agents],
    );
    const platform = formatOSPlatform(props.machine.metadata?.platform);
    const host = props.machine.metadata?.host?.trim();

    // Plan 10 MPG-10: a summary is a fact already held (cached or in settings), never a description. A row with no
    // fact yet is its title alone, and the line appears when the cache has state; nothing here fetches.
    const summaries: Readonly<Record<MachineThisMachinePageId, string | undefined>> = {
        work: undefined,
        sharing: describeMachineSharingSummary(props.machine),
        agents: agentsReady ?? undefined,
        terminal: describeMachineTerminalHost(terminalHost),
        connection,
        installables: undefined,
        doctor: describeMachineDoctorSummary(doctor),
        details: [host, platform].filter(Boolean).join(' · ') || undefined,
    };

    const open = (page: MachineThisMachinePageId) => {
        router.push(machinePageHref({ door, target: { machineId, serverId: props.serverId }, page }) as never);
    };

    return (
        <View testID="machine-page-this-machine">
            <ItemGroup title={t('machineDetailPage.thisMachineTitle')}>
                {MACHINE_THIS_MACHINE_PAGES.map((page) => (
                    <Item
                        key={page}
                        testID={`machine-page-row-${page}`}
                        title={t(MACHINE_SUB_PAGE_TITLE_KEYS[page])}
                        subtitle={summaries[page]}
                        icon={<Icon name={ROW_ICONS[page]} />}
                        showChevron
                        onPress={() => open(page)}
                    />
                ))}
            </ItemGroup>
        </View>
    );
});
