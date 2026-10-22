import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { AgentsAcpBackendsInstallFromRegistryOutputV1Schema } from '@happier-dev/protocol/acp/catalog/registry/registryInstallActionV1';
import type { AcpPlatformFitV1 } from '@happier-dev/protocol/acp/catalog/registry/acpPlatformFitV1';
import { selectAcpRegistryDistributionV1 } from '@happier-dev/protocol/acp/catalog/registry/mapAcpRegistryAgentV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type {
  AcpRegistryAgentV1,
  RegistryItemSummaryV1,
} from '@happier-dev/protocol/registries';

import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import {
  CapabilityAddModalBody,
  openCapabilityAddModalHost,
  type CapabilityAddModalConfig,
} from '@/components/capabilities/add/CapabilityAddModal';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { useAcpCatalogBackends } from '@/components/settings/acpCatalog/useAcpCatalogBackends';
import { AcpAgentGlyph } from '@/components/settings/acpCatalog/CustomAcpAgentMark';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import type { CustomModalInjectedProps } from '@/modal/types';
import { useRegistryItems } from '@/registries/useRegistryItems';
import { useRegistrySources } from '@/registries/useRegistrySources';
import { useRegistrySourcesSlot } from '@/registries/useRegistrySourcesSlot';
import { useReachMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';

import { confirmAgentInstallChange } from '../install/agentInstallChangeConfirm';
import { useAgentAdministrationCatalog } from '../collection/useAgentAdministrationCatalog';
import { presentMachineAdministrationTargetState } from '@/components/settings/machines/MachineAdministrationTargetSelector';
import {
  AgentRegistryDetail,
  AgentBuiltInDetail,
  type AgentAddDraft,
  type AgentInstallChoice,
} from './AgentRegistryDetail';
import {
  agentAddRowKey,
  buildAgentAddRows,
  publisherName,
  findAddedAgentDefinition,
  resolveAgentMachineFits,
  type AgentAddMachine,
  type AgentAddRow,
} from './agentAddRows';

export type OpenAgentAddModalParams = Readonly<{
  /** From a command: the page's draft editor (`/settings/agents/custom/new`). */
  onCommand: () => void;
  /** Open an added agent's page (on dismiss after an add, focus returns to its row). */
  onOpenDefinition: (definitionId: string) => void;
  /** Open a built-in agent's page ("Open Claude Code"). */
  onOpenAgent: (entry: ResolvedAgentCatalogEntry) => void;
  initialModeKey?: 'browse';
  sourceId?: string;
  query?: string;
}>;

const TEST_ID = 'agents.add';
/** Where "How to publish a plugin" leads (the plugin docs' packaging and install page). */
const PUBLISH_PLUGIN_DOCS_URL = 'https://docs.happier.dev/plugins/packaging';

/**
 * Add an agent (P9 U9.4): the one capability Add modal over the agent registries. Add resolves with `then: 'stay'`,
 * so the details become that agent's per-machine install; dismissing then returns to the Agents page on its row.
 */
export function openAgentAddModal(
  params: OpenAgentAddModalParams,
): Readonly<{ close: () => void }> {
  const session: { lastAdded: string | null } = { lastAdded: null };
  return openCapabilityAddModalHost(
    AgentAddModal,
    {
      params,
      onAddedStay: (definitionId: string) => {
        session.lastAdded = definitionId;
      },
    },
    {
      title: t('capabilities.agentAdd.title'),
      subtitle: t('capabilities.agentAdd.subtitle'),
      testID: TEST_ID,
      onRequestClose: () => {
        if (session.lastAdded) params.onOpenDefinition(session.lastAdded);
      },
    },
  );
}

/** What the add owns per row, after the primary resolved. */
export type AgentAddState = Readonly<{
  status: 'added';
  definitionId: string;
  installOn: readonly string[];
}>;
type PluginAgentAddState = Readonly<{ status: 'added'; pluginId: string }>;

/** Machines as the add details judge them: published OS/CPU facts, name, presence. */
export function useAgentAddMachines(): readonly AgentAddMachine[] {
  const { machines } = useReachMachines();
  return React.useMemo(
    () =>
      machines.map((machine) => ({
        machineId: machine.machineId,
        name: machine.name ?? machine.machineId,
        platform: machine.os ?? null,
        arch: machine.arch ?? null,
        offline: machine.offline,
      })),
    [machines],
  );
}

type Execute = ReturnType<typeof useMountedActionExecution>['execute'];

/** Where the download comes from, by the distribution the mapper will choose. */
function downloadHost(
  agent: AcpRegistryAgentV1,
  fits: readonly Readonly<{ fit: AcpPlatformFitV1 }>[],
): string | null {
  const selected = selectAcpRegistryDistributionV1(agent.distributions);
  if (selected?.kind === 'npm') return 'npmjs.com';
  if (selected?.kind === 'uv') return 'pypi.org';
  const target = fits.find(
    ({ fit }) => fit.kind === 'can_run' && fit.target,
  )?.fit;
  const asset =
    target?.kind === 'can_run' && target.target
      ? agent.distributions.binary?.[target.target]
      : undefined;
  try {
    return asset ? new URL(asset.archiveUrl).host : null;
  } catch {
    return null;
  }
}

/**
 * Add agent: one confirm naming the machines installing now and on first use, then the one Action writes the
 * definition and starts each machine's job. `null` when the person declines (nothing changes).
 */
export async function addRegistryAgent(
  input: Readonly<{
    row: Pick<RegistryItemSummaryV1, 'sourceId' | 'itemId'>;
    agent: AcpRegistryAgentV1;
    machines: readonly AgentAddMachine[];
    choice: AgentInstallChoice;
    execute: Execute;
    confirm?: typeof confirmAgentInstallChange;
  }>,
): Promise<Readonly<{
  definitionId: string;
  installOn: readonly string[];
}> | null> {
  const fits = resolveAgentMachineFits(
    input.agent.distributions,
    input.machines,
  );
  const runnable = fits
    .filter(({ fit }) => fit.kind === 'can_run')
    .map(({ machine }) => machine);
  const now =
    input.choice === 'now'
      ? runnable.filter((machine) => !machine.offline)
      : [];
  const firstUse = runnable.filter((machine) => !now.includes(machine));
  const confirmed = await (input.confirm ?? confirmAgentInstallChange)({
    name: input.agent.name,
    version: input.agent.version,
    nowMachines: now.map((machine) => machine.name),
    firstUseMachines: firstUse.map((machine) => machine.name),
    sourceHost: downloadHost(input.agent, fits),
  });
  if (!confirmed) return null;
  const installOn = now.map((machine) => machine.machineId);
  const result = await input.execute(
    'agents.acp.backends.installFromRegistry',
    {
      fromRegistry: {
        sourceId: input.row.sourceId,
        itemId: input.row.itemId,
        version: input.agent.version,
      },
      ...(installOn.length > 0 ? { installOn } : {}),
    },
    {
      presentUserConfirmation: {
        actionId: 'agents.acp.backends.installFromRegistry',
      },
    },
  );
  if (!result.ok)
    throw new Error(result.error || t('capabilities.add.addFailed'));
  const output = AgentsAcpBackendsInstallFromRegistryOutputV1Schema.parse(
    result.result,
  );
  return {
    definitionId: output.definition.id,
    installOn: output.jobs.map((job) => job.machineId),
  };
}

export function AgentAddModal(
  props: CustomModalInjectedProps &
    Readonly<{
      params: OpenAgentAddModalParams;
      onAddedStay: (definitionId: string) => void;
    }>,
): React.ReactElement {
  const { params, onAddedStay } = props;
  const { theme } = useUnistyles();
  const scope = useAccountSettingsScope();
  const { execute } = useMountedActionExecution(scope);
  const machines = useAgentAddMachines();
  const { agentEntries, targetSelection, executionTarget } = useAgentAdministrationCatalog({
    loadProjection: false,
  });
  const { backends: definitions } = useAcpCatalogBackends();
  const { sources: allSources } = useRegistrySources('agent');
  const sourceTitle = React.useCallback(
    (sourceId: string) =>
      allSources.find((source) => source.id === sourceId)?.title ?? sourceId,
    [allSources],
  );
  const slot = useRegistrySourcesSlot('agent', {
    ...(params.sourceId ? { initialSelection: params.sourceId } : {}),
    testID: `${TEST_ID}.registries`,
  });
  const [query, setQuery] = React.useState(params.query ?? '');
  const selectedFormat =
    slot.selection === 'all'
      ? null
      : (allSources.find((source) => source.id === slot.selection)?.format ?? null);
  const acpSourceId =
    allSources.find((source) => source.format === 'acp-registry')?.id ?? null;
  const catalog = useRegistryItems({
    kind: 'agent',
    ...(slot.sourceIds ? { sourceIds: slot.sourceIds } : {}),
    ...(query.trim() ? { query: query.trim() } : {}),
  });

  const [drafts, setDrafts] = React.useState<
    ReadonlyMap<string, AgentAddDraft>
  >(() => new Map());
  // Built-in rows whose registry version the person chose to add as a separate agent (F5): they show the registry
  // agent's own details and its confirmed Add.
  const [separate, setSeparate] = React.useState<ReadonlySet<string>>(() => new Set());
  const [adds, setAdds] = React.useState<ReadonlyMap<string, AgentAddState | PluginAgentAddState>>(
    () => new Map(),
  );
  const draftSetters = React.useRef(
    new Map<string, (draft: AgentAddDraft) => void>(),
  );
  const draftSetter = React.useCallback((key: string) => {
    let setter = draftSetters.current.get(key);
    if (!setter) {
      setter = (draft: AgentAddDraft) =>
        setDrafts((previous) => {
          const current = previous.get(key);
          if (
            current &&
            current.payload === draft.payload &&
            current.choice === draft.choice
          )
            return previous;
          return new Map(previous).set(key, draft);
        });
      draftSetters.current.set(key, setter);
    }
    return setter;
  }, []);

  const { rows, groups } = React.useMemo(
    () =>
      buildAgentAddRows({
        items: catalog.items,
        catalogEntries: agentEntries,
        definitions,
        machines,
      }),
    [agentEntries, catalog.items, definitions, machines],
  );

  const anatomy = React.useMemo(
    () =>
      buildCapabilityCollectionAnatomy<AgentAddRow>({
        title: (row) => row.summary.title,
        description: (row) => row.summary.description?.trim() || null,
        mark: (row) => (
          <AcpAgentGlyph iconUrl={row.summary.iconUrl ?? null} size={20} />
        ),
        whereSummary: (row) => {
          const status = adds.has(row.key)
            ? { kind: 'added' as const }
            : row.status;
          if (!status) return null;
          const label =
            status.kind === 'builtIn'
              ? t('capabilities.agentAdd.status.builtIn')
              : status.kind === 'added'
                ? t('capabilities.agentAdd.status.added')
                : status.kind === 'cantRun'
                  ? t('capabilities.agentAdd.status.cantRun')
                  : status.kind === 'unknown'
                    ? t('capabilities.agentAdd.status.unknown')
                    : t('capabilities.agentAdd.status.cantAddYet');
          return (
            <View
              style={styles.where}
              testID={`${TEST_ID}.row.${row.summary.itemId}.where`}
            >
              {status.kind === 'added' ? (
                <Icon
                  name="check"
                  size={ICON_SIZE.xs}
                  color={theme.colors.text.secondary}
                />
              ) : null}
              <Text
                variant="meta"
                numberOfLines={1}
                style={{ color: theme.colors.text.secondary }}
              >
                {label}
              </Text>
            </View>
          );
        },
        facts: (row) => ({
          presentation: 'row',
          extra: [
            publisherName(row.summary.publisher?.name),
            row.summary.version,
            distributionLabel(row.summary.agentDistribution?.kind),
            row.summary.license,
          ].filter((fact): fact is string => Boolean(fact)),
        }),
        accessibilityLabel: (row) => row.summary.title,
        testID: (row) => `${TEST_ID}.row.${row.summary.itemId}`,
      }),
    [adds, theme.colors.text.secondary],
  );

  const config = React.useMemo(
    (): CapabilityAddModalConfig<AgentAddRow> => ({
      title: t('capabilities.agentAdd.title'),
      subtitle: t('capabilities.agentAdd.subtitle'),
      testID: TEST_ID,
      initialModeKey: 'browse',
      modes: [
        {
          key: 'browse',
          label: t('capabilities.agentAdd.modes.browse'),
          icon: 'magnifying-glass',
          kind: 'catalog',
        },
        {
          key: 'command',
          label: t('capabilities.agentAdd.modes.command'),
          icon: 'terminal',
          kind: 'handoff',
          onSelect: params.onCommand,
        },
      ],
      sources: slot.sources,
      catalog: {
        query,
        onQueryChange: setQuery,
        searchPlaceholder: t('capabilities.agentAdd.searchPlaceholder'),
        items: rows,
        groups: groups.map((group) => ({
          key: group.key,
          title: group.pick
            ? t('capabilities.agentAdd.groupPicks')
            : sourceTitle(group.sourceId),
          trailing: String(group.itemKeys.length),
          itemKeys: group.itemKeys,
        })),
        itemKey: (row) => row.key,
        anatomy,
        loading: catalog.loading && rows.length === 0,
        sourceFailures: catalog.sourceFailures.map((failure) => ({
          ...failure,
          message: `${sourceTitle(failure.sourceId)} · ${failure.message}`,
        })),
        empty: (
          <AgentCatalogEmpty
            query={query}
            pluginSource={selectedFormat === 'happier-npm'}
            onClear={() => setQuery('')}
            {...(acpSourceId
              ? {
                  onBrowseRegistry: () => {
                    setQuery('');
                    slot.setSelection(acpSourceId);
                  },
                }
              : {})}
          />
        ),
        footer: (
          <View style={styles.note} testID={`${TEST_ID}.trustNote`}>
            <Icon name="shield-check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text variant="meta" style={styles.noteText}>
              {selectedFormat === 'happier-npm'
                ? t('capabilities.agentAdd.plugin.listTrustNote')
                : t('capabilities.agentAdd.trustNote')}
            </Text>
          </View>
        ),
      },
      renderDetail: (row, ctx) => {
        const added = ctx.added ? adds.get(row.key) : null;
        return row.status?.kind === 'builtIn' && !separate.has(row.key) ? (
          <AgentBuiltInDetail
            key={row.key}
            row={row}
            entry={row.status.entry}
            sourceTitle={sourceTitle(row.summary.sourceId)}
            onAddSeparate={() => setSeparate((previous) => new Set(previous).add(row.key))}
            testID={TEST_ID}
          />
        ) : (
          <AgentRegistryDetail
            key={row.key}
            row={row}
            sourceTitle={sourceTitle(row.summary.sourceId)}
            machines={machines}
            serverId={scope?.serverId ?? null}
            added={added && 'definitionId' in added ? added : null}
            existingDefinitionId={
              row.status?.kind === 'added' ? row.status.definitionId : null
            }
            targetSelection={targetSelection}
            onDraft={draftSetter(row.key)}
            testID={TEST_ID}
          />
        );
      },
      detailFooter: (row) => {
        const note = (
          <View style={styles.note}>
            <Icon
              name="lock"
              size={ICON_SIZE.xs}
              color={theme.colors.text.secondary}
            />
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>
              {t('capabilities.agentAdd.footerNote')}
            </Text>
          </View>
        );
        if (row.status?.kind === 'builtIn' && !separate.has(row.key)) {
          const entry = row.status.entry;
          return {
            primary: {
              label: t('capabilities.agentAdd.openAgent', {
                name: entry.title,
              }),
              onPress: async () => ({
                itemId: `agent:${entry.agentId}`,
                then: 'close' as const,
              }),
            },
          };
        }
        const existing = findAddedAgentDefinition(definitions, row.summary);
        if (existing && !adds.has(row.key)) {
          return {
            primary: {
              label: t('capabilities.agentAdd.openAgent', {
                name: existing.title ?? existing.name,
              }),
              onPress: async () => ({
                itemId: `definition:${existing.id}`,
                then: 'close' as const,
              }),
            },
          };
        }
        const draft = drafts.get(row.key);
        if (draft?.payload?.kind === 'plugin') {
          const { listing, source } = draft.payload;
          const target = scope && executionTarget && areServerProfileIdentifiersEquivalent(executionTarget.serverId, scope.serverId)
            && targetSelection.selectedTargetServerMatchesActiveAccount ? executionTarget : null;
          return {
            provenance: (
              <View style={styles.note}>
                <Icon name="shield" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                <Text variant="meta" style={styles.noteText}>
                  {t('capabilities.agentAdd.plugin.footerNote')}
                </Text>
              </View>
            ),
            ...(adds.has(row.key) ? { afterAdd: {} } : {}),
            primary: {
              label: t('capabilities.agentAdd.plugin.reviewAndInstall'),
              ...(row.summary.problem ? { disabledReason: t('capabilities.agentAdd.detail.unsupportedEntry') }
                : !target ? { disabledReason: targetSelection.state.kind === 'online'
                    ? t('settingsPlugins.targetSelection.unknown') : presentMachineAdministrationTargetState(targetSelection.state).title } : {}),
              onPress: async () => {
                if (!scope || !target || row.summary.problem) return null;
                const fresh = targetSelection.resolveExecutionTarget({ accountScope: scope });
                if (!fresh || !areServerProfileIdentifiersEquivalent(fresh.serverId, scope.serverId)
                  || fresh.machine.id !== target.machine.id) return null;
                const result = await execute('plugins.install', {
                  machineId: fresh.machine.id,
                  source: { kind: 'marketplace', sourceId: source.id, pluginId: listing.pluginId,
                    version: listing.distribution.version, packageName: listing.distribution.packageName },
                });
                if (!result.ok) throw new Error(result.error || t('capabilities.add.addFailed'));
                const output = getActionSpec('plugins.install').outputSchema?.parse(result.result);
                if (!output || typeof output !== 'object' || !('ok' in output))
                  throw new Error(t('capabilities.add.addFailed'));
                if (!output.ok) {
                  if ('change' in output && output.change && typeof output.change === 'object'
                    && 'kind' in output.change && output.change.kind === 'cancelled') return null;
                  throw new Error(t('capabilities.add.addFailed'));
                }
                setAdds(previous => new Map(previous).set(row.key, { status: 'added', pluginId: listing.pluginId }));
                return { itemId: listing.pluginId, then: 'stay' as const };
              },
            },
          };
        }
        const agent = draft?.payload?.kind === 'agent' ? draft.payload.agent : null;
        const fits = agent
          ? resolveAgentMachineFits(agent.distributions, machines)
          : [];
        const disabledReason = row.summary.problem
          ? t('capabilities.agentAdd.detail.unsupportedEntry')
          : !agent
            ? t('capabilities.agentAdd.detail.loading')
            : machines.length > 0 &&
                !fits.some(({ fit }) => fit.kind === 'can_run')
              ? t('capabilities.agentAdd.detail.noRunnableMachine')
              : undefined;
        const addedResult = adds.get(row.key);
        const addedState = addedResult && 'definitionId' in addedResult ? addedResult : null;
        return {
          provenance: note,
          ...(addedState
            ? {
                afterAdd: {
                  open: {
                    label: t('capabilities.agentAdd.openAgent', {
                      name: agent?.name ?? row.summary.title,
                    }),
                    onPress: () => params.onOpenDefinition(addedState.definitionId),
                  },
                },
              }
            : {}),
          primary: {
            label: t('capabilities.agentAdd.addAgent'),
            ...(disabledReason ? { disabledReason } : {}),
            onPress: async () => {
              if (!agent || !draft) return null;
              const added = await addRegistryAgent({
                row: row.summary,
                agent,
                machines,
                choice: draft.choice,
                execute,
              });
              if (!added) return null;
              setAdds((previous) =>
                new Map(previous).set(row.key, { status: 'added', ...added }),
              );
              onAddedStay(added.definitionId);
              return { itemId: added.definitionId, then: 'stay' as const };
            },
          },
        };
      },
      onAdded: ({ itemId }) => {
        if (itemId.startsWith('definition:'))
          params.onOpenDefinition(itemId.slice('definition:'.length));
        if (itemId.startsWith('agent:')) {
          const entry = agentEntries.find(
            (candidate) => candidate.agentId === itemId.slice('agent:'.length),
          );
          if (entry) params.onOpenAgent(entry);
        }
      },
    }),
    [
      adds,
      agentEntries,
      anatomy,
      catalog.loading,
      catalog.sourceFailures,
      definitions,
      draftSetter,
      drafts,
      execute,
      executionTarget,
      groups,
      machines,
      onAddedStay,
      params,
      query,
      rows,
      acpSourceId,
      scope,
      selectedFormat,
      separate,
      slot,
      sourceTitle,
      targetSelection,
      theme.colors.text.secondary,
    ],
  );

  return <CapabilityAddModalBody {...props} config={config} />;
}

/**
 * The catalog with nothing in it. A search that matched nothing offers Clear. An empty Happier plugin source (P9 F6,
 * lab aa H) says what a plugin agent is and why the list is empty, then leads to the ACP Registry and to publishing.
 */
export function AgentCatalogEmpty(
  props: Readonly<{
    query: string;
    pluginSource: boolean;
    onClear: () => void;
    onBrowseRegistry?: () => void;
  }>,
) {
  const { theme } = useUnistyles();
  const query = props.query.trim();
  if (!query && props.pluginSource) {
    return (
      <EmptyState
        layout="centered"
        size="page"
        scene="noPlugins"
        title={t('capabilities.agentAdd.pluginsEmpty.title')}
        subtitle={t('capabilities.agentAdd.pluginsEmpty.body')}
        {...(props.onBrowseRegistry
          ? {
              primaryAction: {
                label: t('capabilities.agentAdd.pluginsEmpty.browseRegistry'),
                onPress: props.onBrowseRegistry,
                testID: `${TEST_ID}.empty.browseRegistry`,
              },
            }
          : {})}
        secondaryAction={{
          label: t('capabilities.agentAdd.pluginsEmpty.publish'),
          onPress: () => openExternalUrl(PUBLISH_PLUGIN_DOCS_URL),
          testID: `${TEST_ID}.empty.publish`,
        }}
        testID={`${TEST_ID}.empty.plugins`}
      />
    );
  }
  return (
    <View style={styles.empty}>
      <Text variant="body" style={{ color: theme.colors.text.secondary }}>
        {query
          ? t('capabilities.agentAdd.noMatch', { query })
          : t('capabilities.agentAdd.nothingHere')}
      </Text>
      {query ? (
        <RoundButton
          size="small"
          display="inverted"
          title={t('capabilities.agentAdd.clear')}
          onPress={props.onClear}
          testID={`${TEST_ID}.empty.clear`}
        />
      ) : null}
    </View>
  );
}

export { agentAddRowKey };

/** The list's one-word answer to "what does it download" (lab aa L: npm package / Binary download). */
function distributionLabel(kind: 'npm' | 'uv' | 'archive' | undefined): string | null {
  if (kind === 'npm') return t('capabilities.agentAdd.distribution.npm');
  if (kind === 'uv') return t('capabilities.agentAdd.distribution.uv');
  if (kind === 'archive') return t('capabilities.agentAdd.distribution.archive');
  return null;
}



const styles = StyleSheet.create((theme) => ({
  where: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 },
  note: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  noteText: { flex: 1, minWidth: 0, color: theme.colors.text.secondary },
  empty: {
    alignItems: 'center',
    gap: theme.space.s12,
    paddingVertical: theme.space.s32,
  },
}));
