import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { selectAcpRegistryDistributionV1 } from '@happier-dev/protocol/acp/catalog/registry/mapAcpRegistryAgentV1';
import type { RegistryItemV1 } from '@happier-dev/protocol/registries';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { CapabilityStatusChip } from '@/components/capabilities/status/CapabilityStatusChip';
import { AcpAgentGlyph } from '@/components/settings/acpCatalog/CustomAcpAgentMark';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { useRegistryItem } from '@/registries/useRegistryItem';
import { formatAgentNameList } from '@/components/capabilities/identity/agentNameList';
import { t } from '@/text';

import {
  AgentAddingProgress,
  formatMachineOs,
  machineGlyph,
} from './AgentAddingProgress';
import {
  publisherName,
  resolveAgentMachineFits,
  type AgentAddMachine,
  type AgentAddRow,
  type AgentMachineFit,
} from './agentAddRows';
import type { AgentAddState } from './agentAddModalConfig';

/** Away machines listed one by one before they fold into a single "N machines offline" line. */
const OFFLINE_SHOWN_MAX = 3;

export type AgentInstallChoice = 'now' | 'firstUse';

/** What the footer needs from the open details: the read registry entry and the Install choice. */
export type AgentAddDraft = Readonly<{
  payload: Extract<RegistryItemV1['payload'], { kind: 'agent' | 'plugin' }> | null;
  choice: AgentInstallChoice;
}>;

const BUILD_LABELS: Readonly<Record<string, string>> = {
  'darwin-arm64': 'Apple silicon',
  'darwin-x64': 'Intel Mac',
  'linux-arm64': 'ARM64',
  'linux-x64': 'x64',
  'win32-arm64': 'ARM64',
  'win32-x64': 'x64',
};

function fitLine(
  name: string,
  machine: AgentAddMachine,
  fit: AgentMachineFit['fit'],
): string {
  if (fit.kind === 'can_run') {
    if (fit.via === 'archive' && fit.target)
      return t('capabilities.agentAdd.detail.build', {
        target: BUILD_LABELS[fit.target] ?? fit.target,
      });
    return fit.via === 'npm' ? t('capabilities.agentAdd.detail.runsVia.npm')
      : fit.via === 'uv' ? t('capabilities.agentAdd.detail.runsVia.uv')
        : fit.via === 'command' ? t('capabilities.agentAdd.detail.runsVia.command') : t('capabilities.agentAdd.detail.runsVia.archive');
  }
  if (fit.kind === 'unknown')
    return fit.reason === 'arch_unknown'
      ? t('capabilities.agentAdd.detail.archUnknown')
      : t('capabilities.agentAdd.detail.platformUnknown');
  if (fit.reason === 'archive_type_unsupported')
    return t('capabilities.agentAdd.detail.archiveUnsupported', { name });
  const os = formatMachineOs(machine.platform) ?? machine.platform ?? '';
  return t('capabilities.agentAdd.detail.noBuild', {
    name,
    platform: [os, machine.arch === 'arm64' ? 'ARM' : machine.arch]
      .filter(Boolean)
      .join(' on '),
  });
}

/**
 * A registry agent's details (lab aa D/W), in the order the questions arise: can my machines run it (and when it
 * installs), what I'm trusting, what it installs, how it signs in. After Add the same column becomes the install
 * (lab aa X): the person sees each machine's download where the machines were.
 */
export function AgentRegistryDetail(
  props: Readonly<{
    row: AgentAddRow;
    sourceTitle: string;
    machines: readonly AgentAddMachine[];
    serverId: string | null;
    added: AgentAddState | null;
    existingDefinitionId: string | null;
    onDraft: (draft: AgentAddDraft) => void;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const read = useRegistryItem({
    kind: 'agent',
    sourceId: props.row.summary.sourceId,
    itemId: props.row.summary.itemId,
    version: props.row.summary.version,
  });
  const payload = read.item?.payload.kind === 'agent' || read.item?.payload.kind === 'plugin'
    ? read.item.payload : null;
  const agent =
    payload?.kind === 'agent' ? payload.agent : null;
  const [choice, setChoice] = React.useState<AgentInstallChoice>('now');
  const { onDraft } = props;
  React.useEffect(() => {
    onDraft({ payload, choice });
  }, [payload, choice, onDraft]);

  const name = agent?.name ?? props.row.summary.title;
  const fits = React.useMemo(
    () =>
      agent ? resolveAgentMachineFits(agent.distributions, props.machines) : [],
    [agent, props.machines],
  );
  const nowNames = fits
    .filter(({ fit, machine }) => fit.kind === 'can_run' && !machine.offline)
    .map(({ machine }) => machine.name);
  // Online machines answer the question now; a long tail of away machines folds into one line.
  const offlineFits = fits.filter(({ machine }) => machine.offline);
  const foldedOffline = offlineFits.length > OFFLINE_SHOWN_MAX ? offlineFits.length : 0;
  const shownFits = foldedOffline > 0 ? fits.filter(({ machine }) => !machine.offline) : fits;
  const selected = agent
    ? selectAcpRegistryDistributionV1(agent.distributions)
    : null;
  const quiet = { color: theme.colors.text.secondary };

  const header = (
    <CapabilityDetailHeader
      testID={`${props.testID}.detail.header`}
      mark={
        <AcpAgentGlyph iconUrl={props.row.summary.iconUrl ?? null} size={28} />
      }
      title={name}
      {...(props.row.summary.description
        ? { purpose: props.row.summary.description }
        : {})}
      facts={{
        source: { kind: 'registry', label: props.sourceTitle },
        extra: [
          publisherName(props.row.summary.publisher?.name),
          agent?.version ?? props.row.summary.version,
          agent?.license ?? props.row.summary.license,
        ].filter((fact): fact is string => Boolean(fact)),
      }}
    />
  );

  if (props.added) {
    return (
      <View style={styles.detail}>
        {header}
        <AgentAddingProgress
          name={name}
          definitionId={props.added.definitionId}
          serverId={props.serverId}
          machines={fits
            .filter(({ fit }) => fit.kind === 'can_run')
            .map(({ machine }) => machine)}
          installOn={props.added.installOn}
          testID={`${props.testID}.adding`}
        />
      </View>
    );
  }

  if (!agent) {
    return (
      <View style={styles.detail}>
        {header}
        {read.error ? (
          <SurfaceStateCard
            kind="error"
            layout="inline"
            title={t('capabilities.agentAdd.detail.readFailed')}
            diagnosticCode={read.error}
            action={{
              label: t('capabilities.agentAdd.detail.retry'),
              onPress: () => {
                void read.refresh();
              },
            }}
            testID={`${props.testID}.detail.readFailed`}
          />
        ) : read.loading ? (
          <SurfaceStateCard
            kind="loading"
            size="line"
            title={t('capabilities.agentAdd.detail.loading')}
          />
        ) : null}
      </View>
    );
  }

  // The one checksum line (IR-32): about the builds your machines would download, else every published build.
  const runnableTargets = fits.flatMap(({ fit }) => (fit.kind === 'can_run' && fit.target ? [fit.target] : []));
  const checkedAssets = selected?.kind === 'archive'
    ? (runnableTargets.length > 0 ? runnableTargets.map((target) => agent.distributions.binary?.[target]) : Object.values(agent.distributions.binary ?? {}))
    : [];
  const checksum = selected?.kind === 'archive' ? checkedAssets.length > 0 && checkedAssets.every((asset) => Boolean(asset?.sha256)) : null;
  const file = (() => {
    if (selected?.kind === 'npm')
      return {
        title: t('capabilities.agentAdd.detail.installsNpm', {
          pkg: `${selected.distribution.package}@${selected.distribution.version}`,
        }),
        body: t('capabilities.agentAdd.detail.installsNpmBody'),
      };
    if (selected?.kind === 'uv')
      return {
        title: t('capabilities.agentAdd.detail.installsUv', {
          pkg: `${selected.distribution.package}==${selected.distribution.version}`,
        }),
        body: t('capabilities.agentAdd.detail.installsUvBody'),
      };
    const target = fits.find(
      ({ fit }) => fit.kind === 'can_run' && fit.target,
    )?.fit;
    const asset =
      target?.kind === 'can_run' && target.target
        ? agent.distributions.binary?.[target.target]
        : undefined;
    const fileName = asset
      ? decodeURIComponent(
          new URL(asset.archiveUrl).pathname.split('/').pop() ?? '',
        )
      : null;
    return fileName
      ? {
          title: t('capabilities.agentAdd.detail.installsArchive', {
            file: fileName,
          }),
          body: t('capabilities.agentAdd.detail.installsArchiveBody'),
        }
      : null;
  })();

  return (
    <View style={styles.detail}>
      {header}
      <ItemGroup
        title={t('capabilities.agentAdd.detail.machinesTitle')}
        description={t('capabilities.agentAdd.detail.machinesBody')}
      >
        {fits.length === 0 ? (
          <Item
            title={t('capabilities.agentAdd.detail.noMachines')}
            showChevron={false}
          />
        ) : (
          shownFits.map(({ machine, fit }) => (
            <Item
              key={machine.machineId}
              testID={`${props.testID}.detail.machine.${machine.machineId}`}
              title={machine.name}
              titleQualifier={formatMachineOs(machine.platform)}
              titleStyle={
                fit.kind !== 'can_run' || machine.offline ? quiet : undefined
              }
              subtitle={fitLine(name, machine, fit)}
              icon={
                <Icon
                  name={machineGlyph(machine.platform)}
                  size={20}
                  color={theme.colors.text.secondary}
                />
              }
              rightElement={
                fit.kind === 'cant_run' ? (
                  <CapabilityStatusChip status={{ kind: 'cantrun' }} />
                ) : (
                  <Text variant="meta" style={quiet}>
                    {fit.kind === 'unknown'
                      ? t('capabilities.agentAdd.detail.unknownFit')
                      : machine.offline
                        ? t('capabilities.agentAdd.detail.offlineNote')
                        : t('capabilities.agentAdd.detail.canRun')}
                  </Text>
                )
              }
              accessoryLayout="adaptive"
              showChevron={false}
            />
          ))
        )}
        {foldedOffline > 0 ? (
          <Item
            testID={`${props.testID}.detail.offlineMachines`}
            title={t('capabilities.agentAdd.detail.offlineMany', { count: foldedOffline })}
            subtitle={t('capabilities.agentAdd.detail.offlineManyBody')}
            titleStyle={quiet}
            icon={<Icon name="clock" size={20} color={theme.colors.text.secondary} />}
            showChevron={false}
          />
        ) : null}
        {fits.some(({ fit }) => fit.kind === 'can_run') ? (
          <SegmentedChoiceItem<AgentInstallChoice>
            testIDPrefix={`${props.testID}.detail.install`}
            title={t('capabilities.agentAdd.detail.installTitle')}
            subtitle={
              choice === 'firstUse'
                ? t('capabilities.agentAdd.detail.installFirstUseBody')
                : nowNames.length > 0
                  ? t('capabilities.agentAdd.detail.installNowBody', {
                      machines: formatAgentNameList(nowNames),
                    })
                  : t('capabilities.agentAdd.detail.installNoneNow')
            }
            options={[
              {
                id: 'now',
                label: t('capabilities.agentAdd.detail.installNow'),
              },
              {
                id: 'firstUse',
                label: t('capabilities.agentAdd.detail.installFirstUse'),
              },
            ]}
            value={choice}
            onChange={setChoice}
          />
        ) : null}
      </ItemGroup>

      <ItemGroup
        title={t('capabilities.agentAdd.detail.trustTitle')}
        description={t('capabilities.agentAdd.detail.trustBody', { name })}
      >
        {checksum !== null ? (
          <Item
            testID={`${props.testID}.detail.checksum`}
            title={
              checksum
                ? t('capabilities.agentAdd.detail.checksumVerified')
                : t('capabilities.agentAdd.detail.checksumMissing')
            }
            {...(checksum
              ? {
                  subtitle: t(
                    'capabilities.agentAdd.detail.checksumVerifiedBody',
                  ),
                }
              : {})}
            icon={
              <Icon
                name="shield-check"
                size={ICON_SIZE.sm}
                color={theme.colors.text.secondary}
              />
            }
            showChevron={false}
          />
        ) : null}
        <Item
          title={t('capabilities.agentAdd.detail.checkedByRegistry')}
          subtitle={t('capabilities.agentAdd.detail.checkedByRegistryBody')}
          icon={
            <Icon
              name="check-circle"
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />
          }
          showChevron={false}
        />
        {agent.repository || agent.license ? (
          <Item
            title={t('capabilities.agentAdd.detail.sourceAndLicence')}
            subtitle={[
              agent.repository?.replace(/^https?:\/\//, ''),
              agent.license,
            ]
              .filter(Boolean)
              .join(' · ')}
            icon={
              <Icon
                name="github-logo"
                size={ICON_SIZE.sm}
                color={theme.colors.text.secondary}
              />
            }
            showChevron={false}
          />
        ) : null}
      </ItemGroup>

      {file ? (
        <ItemGroup
          title={t('capabilities.agentAdd.detail.installsTitle')}
        >
          <Item
            title={file.title}
            subtitle={file.body}
            titleStyle={styles.mono}
            showChevron={false}
          />
        </ItemGroup>
      ) : null}

      <ItemGroup title={t('capabilities.agentAdd.detail.signInTitle')}>
        <Item
          title={t('capabilities.agentAdd.detail.signInBody', { name })}
          titleLines={2}
          icon={<Icon name="key" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
          showChevron={false}
        />
      </ItemGroup>
    </View>
  );
}

/**
 * An agent Happier already ships (lab aa B): say so, show it is that agent, and lead to its page. Adding the
 * registry's wrapper as a separate agent stays possible elsewhere; the primary is Open.
 */
export function AgentBuiltInDetail(
  props: Readonly<{
    row: AgentAddRow;
    entry: ResolvedAgentCatalogEntry;
    sourceTitle: string;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <View style={styles.detail}>
      <CapabilityDetailHeader
        testID={`${props.testID}.detail.header`}
        mark={
          <AcpAgentGlyph
            iconUrl={props.row.summary.iconUrl ?? null}
            size={28}
          />
        }
        title={props.row.summary.title}
        {...(props.row.summary.description
          ? { purpose: props.row.summary.description }
          : {})}
        facts={{
          source: { kind: 'registry', label: props.sourceTitle },
          extra: [
            publisherName(props.row.summary.publisher?.name),
            props.row.summary.version,
            props.row.summary.license,
          ].filter((fact): fact is string => Boolean(fact)),
        }}
      />
      <ItemGroup>
        <Item
          title={t('capabilities.agentAdd.builtIn.callout', {
            name: props.row.summary.title,
            agent: props.entry.title,
          })}
          subtitle={t('capabilities.agentAdd.builtIn.calloutBody')}
          icon={
            <AgentCatalogIdentityIcon
              entry={props.entry}
              machineId={null}
              serverId={null}
              current={false}
              color={theme.colors.text.secondary}
              size={20}
            />
          }
          showChevron={false}
        />
      </ItemGroup>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  detail: { gap: theme.space.s24 },
  mono: { fontVariant: ['tabular-nums'] },
}));
