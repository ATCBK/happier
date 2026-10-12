import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { matchesUsageSourceAccountingScope, type UsageSourceV1 } from '@happier-dev/protocol/usage/usageSources';
import { UsageSourceInventoryScopeSchema, type UsageSourceInventoryScope } from '@happier-dev/protocol/inputs/usageQuery';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/resolveBundledAgentIdFromContributionIdentity';
import { Modal } from '@/modal';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useWidgetFrameBodyCaption } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
  useActiveServerAccountScope,
  useAllMachines,
} from '@/sync/domains/state/storage';
import type { ServerAccountScope, ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { t } from '@/text';
import { useWidgetPresentation } from '@happier-dev/plugin-ui';
import { UsageAgentMark, usageAgentTitle } from './usageBodyKit';
import type {
  UsageSourcesController,
  UsageSourcesSnapshot,
} from './usageSourcesController';
import { useUsageSourcesController, type UsageSourcesHookOptions } from './useUsageSources';
import { UsageExternalSessionCandidates } from './UsageExternalSessionCandidates';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineReplaced } from '@happier-dev/protocol/machines/identity/canonicalMachineId';

/**
 * Sources (lab d2src/usrc): agent usage already on your machines, found by reading metadata only.
 * Each source is consented per machine with the exact server-disclosure copy, then reads in place;
 * Stop keeps counted history and Delete history is its own confirmed operation. Every effect is the
 * machine's `usage.sources.*` Action through the mounted controller; this body holds no capture state.
 */
export function UsageSourcesWidget(
  props: Readonly<{ input: Readonly<Record<string, JsonValue>>; serverId: string; testID: string }>,
): React.ReactElement {
  const viewer = useActiveServerAccountScope();
  const lifetime = React.useMemo(() => {
    const captured = captureActiveServerAccountScopeLifetime();
    return captured?.scope.serverId === props.serverId ? captured : null;
  }, [viewer?.serverId, viewer?.accountId, props.serverId]);
  const machines = useAllMachines();
  const reachabilityRevision = useMachineReachabilityRevision();
  const nowMs = useMachinePresenceNowMs(machines);
  const presentation = useWidgetPresentation();
  // Online machines first (they can answer now), then by name; offline ones wait quietly.
  const ordered = React.useMemo(() => projectUsageSourcesMachines(machines, nowMs, lifetime?.isCurrent() ? lifetime.scope : null), [machines, nowMs, lifetime, reachabilityRevision]);
  useWidgetFrameBodyCaption(t('usage.board.sources.foundCaption'));
  const inventory = UsageSourceInventoryScopeSchema.safeParse(props.input);
  if (!inventory.success) return <SurfaceStateCard testID={`${props.testID}.invalid`} kind="unavailable"
    layout="inline" size="line" title={t('usage.board.page.queryInvalidTitle')} reason={t('usage.board.page.queryInvalidReason')} />;
  if (!lifetime)
    return (
      <SurfaceStateCard
        testID={`${props.testID}.unavailable`}
        kind="unavailable"
        layout="inline"
        size="line"
        title={t('usage.board.page.signedOutTitle')}
      />
    );
  return (
    <UsageSourcesMachines
      lifetime={lifetime}
      machines={ordered}
      serverId={props.serverId}
      testID={props.testID}
      input={inventory.data}
      compact={presentation !== undefined && presentation.size !== 'large'}
    />
  );
}

/** One machine as Sources reads it: identity, reachability now, and its home for path display. */
export type UsageSourcesMachine = Readonly<{
  id: string;
  name: string;
  online: boolean;
  homeDir?: string;
}>;

/** Sources' inventory projection consumes the canonical presence and display-name owners. */
export function projectUsageSourcesMachines(machines: readonly Pick<Machine, 'id' | 'metadata' | 'active' | 'activeAt' | 'revokedAt' | 'replacedByMachineId' | 'availability'>[], nowMs: number, scope: ServerAccountScope | null): readonly UsageSourcesMachine[] {
  const current = machines.filter(machine => !machine.revokedAt && !isMachineReplaced(machine));
  const names = resolveMachineDisplayNames(current);
  return current.map((machine): UsageSourcesMachine => ({ id: machine.id, online: isMachineSelectableForFleet(scope, machine, nowMs), name: names.get(machine.id)!,
    ...(machine.metadata?.homeDir ? { homeDir: machine.metadata.homeDir } : {}) }))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

/** The machine list beneath the live owners; the executor is the ordinary default unless supplied. */
export function UsageSourcesMachines(
  props: Readonly<{
    lifetime: ServerAccountScopeLifetime;
    machines: readonly UsageSourcesMachine[];
    serverId: string;
    executor?: UsageSourcesHookOptions['executor'];
    testID: string;
    input: UsageSourceInventoryScope;
    compact?: boolean;
  }>,
): React.ReactElement {
  // Source membership comes from metadata discovery, never an Agent or capture-path guess.
  const machines = [...new Map(props.machines
    .filter(machine => !props.input.machines.length || props.input.machines.includes(machine.id))
    .map(machine => [machine.id, machine])).values()];
  const online = machines.filter(machine => machine.online);
  const offlineCount = machines.length - online.length;
  // Only a derived loaded-empty bit leaves each controller. Inventory, source state and demand
  // stay at the mounted leaf; this count cannot label a previous Account or selection as current.
  const projectionKey = JSON.stringify([props.input.agents, props.input.sources, online.map(machine => machine.id)]);
  const [emptyProjection, setEmptyProjection] = React.useState<Readonly<{
    lifetime: ServerAccountScopeLifetime; key: string; ids: ReadonlySet<string>;
  }> | null>(null);
  const reportEmpty = React.useCallback((machineId: string, empty: boolean) => {
    setEmptyProjection(previous => {
      const current = previous?.lifetime === props.lifetime && previous.key === projectionKey ? previous : null;
      if (current && current.ids.has(machineId) === empty) return previous;
      const ids = new Set(current?.ids);
      if (empty) ids.add(machineId); else ids.delete(machineId);
      return { lifetime: props.lifetime, key: projectionKey, ids };
    });
  }, [props.lifetime, projectionKey]);
  const emptyCount = emptyProjection?.lifetime === props.lifetime && emptyProjection.key === projectionKey
    ? online.filter(machine => emptyProjection.ids.has(machine.id)).length : 0;
  if (machines.length === 0)
    return (
      <SurfaceStateCard
        testID={`${props.testID}.empty`}
        kind="empty"
        layout="inline"
        title={t(props.machines.length ? 'usage.board.sources.emptyScopedTitle' : 'usage.board.sources.noMachinesTitle')}
        reason={t(props.machines.length ? 'usage.board.sources.emptyScopedReason' : 'usage.board.sources.noMachinesReason')}
      />
    );
  if (props.compact) return <View testID={`${props.testID}.summary`} style={styles.machines}>
    <Text style={styles.machineName}>{t('projects.identity.machineCount', { count: machines.length })}</Text>
    {offlineCount > 0 ? <Text style={styles.note}>{t('machines.widgets.body.fleet.offlineGroup', { count: offlineCount })}</Text> : null}
  </View>;
  return (
    <View testID={props.testID} style={styles.machines}>
      {online.map((machine, index) => (
        <MachineSources
          key={machine.id}
          machine={machine}
          lifetime={props.lifetime}
          serverId={props.serverId}
          executor={props.executor}
          first={index === 0}
          agentIds={props.input.agents}
          accountingSources={props.input.sources}
          onEmpty={reportEmpty}
          testID={`${props.testID}.machine.${machine.id}`}
        />
      ))}
      {emptyCount > 0 ? <Text testID={`${props.testID}.emptyMachines`} style={styles.note}
        accessibilityLabel={`${t('projects.identity.machineCount', { count: emptyCount })} · ${t('usage.board.sources.machineNone')}`}>
        {t('projects.identity.machineCount', { count: emptyCount })} · {t('usage.board.sources.machineNone')}
      </Text> : null}
      {offlineCount > 0 ? <Text testID={`${props.testID}.offline`} style={styles.note}
        accessibilityLabel={t('machines.widgets.body.fleet.offlineGroup', { count: offlineCount })}>
        {t('machines.widgets.body.fleet.offlineGroup', { count: offlineCount })}
      </Text> : null}
    </View>
  );
}

function MachineSources(
  props: Readonly<{
    machine: UsageSourcesMachine;
    lifetime: ServerAccountScopeLifetime;
    executor?: UsageSourcesHookOptions['executor'];
    serverId: string;
    first: boolean;
    testID: string;
    agentIds: readonly string[];
    accountingSources: readonly string[];
    onEmpty(machineId: string, empty: boolean): void;
  }>,
) {
  const { theme } = useUnistyles();
  const { controller, snapshot } = useUsageSourcesController({
    machineId: props.machine.id,
    lifetime: props.lifetime,
    ...(props.executor ? { executor: props.executor } : {}),
  });
  // Mounting is visible demand (the area only mounts bodies near the viewport): read metadata once.
  React.useEffect(() => {
    if (controller && props.machine.online) void controller.discover();
  }, [controller, props.machine.online]);
  const scoped = snapshot.sources.filter(source => matchesUsageSourceAccountingScope(source, props.accountingSources)
    && (!props.agentIds.length || props.agentIds.some(agentId =>
    agentId === buildQualifiedPluginContributionKey(source.agent)
      || agentId === resolveBundledAgentIdFromContributionIdentity(source.agent))));
  const visible = scoped.filter(
    (source) =>
      !(
        source.consent === 'disabled' &&
        source.status === 'found' &&
        snapshot.dismissedSourceIds.includes(source.sourceId)
      ),
  );
  const counted = scoped.filter(
    (source) => source.consent === 'enabled',
  ).length;
  const discovering = snapshot.pending.some(
    (operation) => operation.actionId === 'usage.sources.discover',
  );
  const empty = snapshot.loaded && scoped.length === 0 && !snapshot.error && !snapshot.approval;
  React.useEffect(() => { props.onEmpty(props.machine.id, empty); }, [props.onEmpty, props.machine.id, empty]);
  const status = !props.machine.online
    ? t('usage.board.sources.machineOffline')
    : !snapshot.loaded
      ? t('usage.board.sources.machineLooking')
      : scoped.length === 0
        ? t('usage.board.sources.machineNone')
        : counted > 0
          ? t('usage.board.sources.machineCounted', { count: counted })
          : null;
  if (empty) return null;
  return (
    <View
      testID={props.testID}
      style={[styles.machine, props.first ? null : styles.machineDivided]}
    >
      <View style={styles.machineHeader}>
        <Icon
          name="desktop"
          size={ICON_SIZE.sm}
          color={theme.colors.text.secondary}
        />
        <Text style={styles.machineName} numberOfLines={1}>
          {props.machine.name}
        </Text>
        {status ? (
          <Text style={styles.machineStatus} numberOfLines={1}>
            {status}
          </Text>
        ) : null}
        {discovering ? (
          <ActivitySpinner
            size={ICON_SIZE.xs}
            color={theme.colors.text.tertiary}
          />
        ) : null}
      </View>
      {snapshot.error && !snapshot.loaded && props.machine.online ? (
        <SurfaceFreshnessLine
          testID={`${props.testID}.error`}
          tone="warning"
          reason={t('usage.board.sources.unavailable')}
          action={{
            label: t('common.retry'),
            onPress: () => controller?.discover(),
          }}
        />
      ) : null}
      {snapshot.approval ? (
        <Text style={styles.note}>
          {t('usage.board.sources.approvalPending')}
        </Text>
      ) : null}
      {controller
        ? visible.map((source) => (
            <SourceRow
              key={source.sourceId}
              source={source}
              snapshot={snapshot}
              controller={controller}
              machineName={props.machine.name}
              lifetime={props.lifetime}
              online={props.machine.online}
                    homeDir={props.machine.homeDir}
              serverId={props.serverId}
              testID={`${props.testID}.source.${source.sourceId}`}
            />
          ))
        : null}
    </View>
  );
}

function SourceRow(
  props: Readonly<{
    source: UsageSourceV1;
    snapshot: UsageSourcesSnapshot;
    controller: UsageSourcesController;
    machineName: string;
    lifetime: ServerAccountScopeLifetime;
    online: boolean;
    homeDir?: string;
    serverId: string;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const { source, controller } = props;
  const agentId = resolveBundledAgentIdFromContributionIdentity(source.agent) ?? buildQualifiedPluginContributionKey(source.agent);
  const agent = usageAgentTitle(agentId);
  const busy = props.snapshot.pending.some(
    (operation) =>
      operation.sourceId === source.sourceId &&
      operation.actionId !== 'usage.sources.get',
  );
  const folder = source.root.path
    ? formatPathRelativeToHome(source.root.path, props.homeDir)
    : t('usage.board.sources.defaultFolder');
  const deletion =
    props.snapshot.historyDeletion?.sourceId === source.sourceId
      ? props.snapshot.historyDeletion
      : null;
  const words = { agent, machine: props.machineName };

  const add = React.useCallback(async () => {
    // Consent is explicit and says exactly what the server keeps (approved UD-1 disclosure).
    const confirmed = await Modal.confirm(
      t('usage.board.sources.consentTitle', words),
      controller.disclosure,
      { confirmText: t('usage.board.sources.add') },
    );
    if (confirmed) await controller.setConsent(source.sourceId, true);
  }, [controller, source.sourceId, agent, props.machineName]);
  const deleteHistory = React.useCallback(async () => {
    const confirmed = await Modal.confirm(
      t('usage.board.sources.deleteTitle', words),
      t('usage.board.sources.deleteMessage'),
      {
        confirmText: t('usage.board.sources.deleteHistory'),
        destructive: true,
      },
    );
    if (confirmed) await controller.deleteHistory(source.sourceId);
  }, [controller, source.sourceId, agent, props.machineName]);
  const changeFolder = React.useCallback(async () => {
    const next = await Modal.prompt(
      t('usage.board.sources.folderPromptTitle'),
      t('usage.board.sources.folderPromptMessage', words),
      {
        defaultValue: source.root.path ?? '',
        placeholder: source.root.path ?? '~',
      },
    );
    // The Machine expands and validates the path with its own home-directory owner.
    if (
      next !== null &&
      next.trim().length > 0 &&
      next.trim() !== source.root.path
    )
      await controller.setRoot(source.sourceId, next.trim());
  }, [controller, source.sourceId, source.root.path, agent, props.machineName]);

  const found = source.consent === 'disabled' && source.status === 'found';
  const state = found
    ? null
    : source.status === 'unsupported' || source.coverage === 'unsupported'
      ? t('usage.board.sources.unsupported')
      : source.status === 'reading'
        ? source.pendingCount > 0
          ? t('usage.board.sources.reading', { count: source.pendingCount })
          : t('usage.board.sources.readingStarted')
        : source.status === 'stopped' ||
            (source.consent === 'disabled' && source.status !== 'error')
          ? t('usage.board.sources.stopped')
          : source.status === 'ready'
            ? source.coverage === 'partial'
              ? t('usage.board.sources.countedPartial')
              : t('usage.board.sources.counted')
            : null;
  const failed = source.status === 'error' || source.status === 'unavailable';
  return (
    <View
      testID={props.testID}
      style={styles.source}
      accessibilityState={{ busy }}
    >
      <View style={styles.sourceMark}>
        <UsageAgentMark
          agentId={agentId}
          serverId={props.serverId}
        />
      </View>
      <View style={styles.sourceBody}>
        <Text style={styles.sourceTitle} numberOfLines={1}>
          {agent}
        </Text>
        <Text style={styles.sourceSubtitle} numberOfLines={1}>
          {t('usage.board.sources.rootOnMachine', {
            path: folder,
            machine: props.machineName,
          })}
        </Text>
        {state ? (
          <View style={styles.stateLine}>
            {source.status === 'reading' ? (
              <ActivitySpinner
                size={ICON_SIZE.xs}
                color={theme.colors.text.link}
              />
            ) : source.status === 'ready' ? (
              <Icon
                name="check"
                size={ICON_SIZE.xs}
                color={theme.colors.state.success.foreground}
              />
            ) : null}
            <Text style={styles.stateText} numberOfLines={2}>
              {state}
            </Text>
          </View>
        ) : null}
        {failed ? (
          <SurfaceFreshnessLine
            testID={`${props.testID}.failed`}
            tone="warning"
            asOf={source.asOfMs}
            reason={t(
              source.status === 'error'
                ? 'usage.board.sources.failed'
                : 'usage.board.sources.unavailable',
            )}
            action={{
              label: t('common.retry'),
              onPress: () => controller.refresh(source.sourceId),
            }}
          />
        ) : null}
        {deletion ? (
          <Text style={styles.note}>
            {t('usage.board.sources.deleted', {
              count: deletion.deletedEventCount,
            })}
          </Text>
        ) : null}
        <View style={styles.actions}>
          {found ? (
            <>
              <RoundButton
                size="small"
                display="secondary"
                title={t('usage.board.sources.add')}
                loading={busy}
                onPress={() => {
                  void add();
                }}
                testID={`${props.testID}.add`}
              />
              <RoundButton
                size="small"
                display="inverted"
                title={t('usage.board.sources.notNow')}
                disabled={busy}
                onPress={() => {
                  void controller.notNow(source.sourceId);
                }}
                testID={`${props.testID}.notNow`}
              />
            </>
          ) : source.consent === 'enabled' ? (
            <>
              <RoundButton
                size="small"
                display="secondary"
                title={t('usage.board.sources.stop')}
                loading={busy}
                onPress={() => {
                  void controller.stop(source.sourceId);
                }}
                testID={`${props.testID}.stop`}
              />
            </>
          ) : source.status !== 'unsupported' ? (
            <>
              <RoundButton
                size="small"
                display="secondary"
                title={t('usage.board.sources.resume')}
                loading={busy}
                onPress={() => {
                  void add();
                }}
                testID={`${props.testID}.resume`}
              />
            </>
          ) : null}
          {source.consent === 'enabled' || source.status === 'stopped' || source.pendingCount > 0 || source.asOfMs !== null ? (
            <RoundButton
              size="small"
              display="inverted"
              title={t('usage.board.sources.deleteHistory')}
              disabled={busy}
              onPress={() => {
                void deleteHistory();
              }}
              testID={`${props.testID}.delete`}
            />
          ) : null}
          <RoundButton
            size="small"
            display="inverted"
            title={t('usage.board.sources.changeFolder')}
            disabled={busy}
            onPress={() => { void changeFolder(); }}
            testID={`${props.testID}.folder`}
          />
          {source.root.kind === 'override' ? (
            <RoundButton
              size="small"
              display="inverted"
              title={t('usage.board.sources.useDefaultFolder')}
              disabled={busy}
              onPress={() => {
                void controller.setRoot(source.sourceId, null);
              }}
              testID={`${props.testID}.defaultFolder`}
            />
          ) : null}
        </View>
        {source.externalSessionSource ? <UsageExternalSessionCandidates source={source} lifetime={props.lifetime}
          online={props.online} testID={`${props.testID}.outside`} /> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  machines: {
    gap: theme.space.s4,
  },
  machine: {
    gap: theme.space.s12,
    paddingVertical: theme.space.s12,
  },
  machineDivided: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  machineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    minWidth: 0,
  },
  machineName: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
    flexShrink: 1,
  },
  machineStatus: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    flexShrink: 1,
  },
  source: {
    flexDirection: 'row',
    gap: theme.space.s12,
    alignItems: 'flex-start',
    paddingLeft: theme.space.s4,
  },
  sourceMark: {
    paddingTop: theme.space.s2,
  },
  sourceBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.space.s2,
  },
  sourceTitle: {
    ...Typography.default('semiBold'),
    color: theme.colors.text.primary,
  },
  sourceSubtitle: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
  },
  stateLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    marginTop: theme.space.s6,
  },
  stateText: {
    ...Typography.default(),
    color: theme.colors.text.secondary,
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  note: {
    ...Typography.default(),
    color: theme.colors.text.tertiary,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.space.s8,
    marginTop: theme.space.s10,
  },
}));
