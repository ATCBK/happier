import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';

import { useSessionContextLayers } from '@/components/sessions/work/context/useSessionContextLayers';
import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { useSessionSelector } from '@/sync/store/hooks';
import type { MemoryDecisionTarget } from '@/sync/ops/promptLibrary/memoryDocuments';
import { t } from '@/text';

import { useMemoryDocument } from './useMemoryDocument';
import type { useSaveMemoryDecision } from './useSaveMemoryDecision';

type Model = ReturnType<typeof useSaveMemoryDecision>;

const noop = () => undefined;

/** Up to this many places read as one segmented row (lab K2-Sd); more become a menu. */
const MAX_SEGMENTS = 3;

export function memoryDecisionTargetId(target: MemoryScopeTargetV1): string {
  return target.scope === 'account'
    ? 'account'
    : `project:${target.projectRef.serverId}:${target.projectRef.projectKey}`;
}

function memoryDecisionBaseLabel(row: MemoryDecisionTarget): string {
  if (row.target.scope === 'account') return t('memoryContext.memory.sheetSaveToOnlyMe');
  return row.label ?? (row.workspaceRef ? resolveWorkspaceRefDisplayName(row.workspaceRef) : row.target.projectRef.projectKey);
}

/** Names for the offered places; Projects that share a name are told apart by the one workspace-label owner. */
export function memoryDecisionTargetLabels(rows: readonly MemoryDecisionTarget[]): ReadonlyMap<string, string> {
  const refs = rows.flatMap((row) => (row.workspaceRef ? [row.workspaceRef] : []));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(memoryDecisionBaseLabel(row), (counts.get(memoryDecisionBaseLabel(row)) ?? 0) + 1);
  return new Map(rows.map((row) => {
    const base = memoryDecisionBaseLabel(row);
    const label = (counts.get(base) ?? 0) > 1 && row.workspaceRef ? resolveWorkspaceRefDisplayName(row.workspaceRef, refs) : base;
    return [memoryDecisionTargetId(row.target), label] as const;
  }));
}

/** The destination the Action itself picks when nothing was chosen: which listed place that is, or null when unknown. */
type NaturalTarget = Readonly<{ id: string | null }>;

function useSessionNaturalTarget(
  session: Readonly<{ sessionId: string; serverId: string }>,
  rows: readonly MemoryDecisionTarget[],
): NaturalTarget {
  const stored = useSessionSelector(
    session.sessionId,
    session.serverId,
    (current) => current ?? null,
  );
  const ownerMetadata = React.useMemo(
    () => (stored ? readSessionOwnerMetadataView(stored) : null),
    [stored],
  );
  const layers = useSessionContextLayers({
    sessionId: session.sessionId,
    serverId: session.serverId,
    ownerMetadata,
    metadataVersion: stored?.metadataVersion ?? 0,
  });
  const loaded = stored !== null;
  return React.useMemo(() => {
    // The `memory.remember` rule: the Session's Project memory when it has a Project, else the Account's.
    // A Session that is not loaded here says nothing about its Project; a Bot writes to its own memory.
    if (!loaded || layers.isBot) return { id: null };
    if (layers.project.status === 'none') return { id: 'account' };
    const name = layers.project.name;
    const named =
      name === null
        ? []
        : rows.filter(
            (row) =>
              row.target.scope === 'project' &&
              memoryDecisionBaseLabel(row) === name,
          );
    return {
      id: named.length === 1 ? memoryDecisionTargetId(named[0]!.target) : null,
    };
  }, [layers.isBot, layers.project.name, layers.project.status, rows, loaded]);
}

/** Who can read the chosen memory, from its admitted audience; a memory not yet created is only the person's. */
function TargetAudienceLine(props: Readonly<{ row: MemoryDecisionTarget }>) {
  const { row } = props;
  const source = useMemoryDocument({
    ref: row.ref,
    serverId: row.ref?.serverId ?? null,
    enabled: row.ref !== null,
  });
  const audience = source.view?.audience ?? null;
  const shared =
    row.ref === null
      ? false
      : source.stale
        ? null
        : (source.view?.shared ?? null);
  if (shared === null) return null;
  const text = shared
    ? audience?.team
      ? t('memoryContext.memory.sharedWithTeam', { team: audience.team })
      : t('memoryContext.memory.accessShared')
    : t('memoryContext.memory.accessPrivate');
  return (
    <View style={styles.audience} testID="save-memory-decision.audience">
      <Icon name={shared ? 'users' : 'lock'} size={14} />
      <Text style={styles.meta}>{text}</Text>
    </View>
  );
}

function TargetChoice(
  props: Readonly<{ model: Model; natural: NaturalTarget }>,
) {
  const { model, natural } = props;
  const { targets, selectedTarget, selectTarget, targetCoverage } = model;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const activeId = selectedTarget
    ? memoryDecisionTargetId(selectedTarget)
    : natural.id;
  const active =
    targets.find((row) => memoryDecisionTargetId(row.target) === activeId) ??
    null;
  const locked =
    model.busy || model.notice === 'pending' || model.creationReceipt !== null;
  const choose = React.useCallback(
    (id: string) => {
      const row = targets.find(
        (candidate) => memoryDecisionTargetId(candidate.target) === id,
      );
      if (row) selectTarget(row.target);
      setMenuOpen(false);
    },
    [selectTarget, targets],
  );
  const labels = React.useMemo(() => memoryDecisionTargetLabels(targets), [targets]);
  const options = React.useMemo(
    () =>
      targets.map((row) => ({
        id: memoryDecisionTargetId(row.target),
        label: labels.get(memoryDecisionTargetId(row.target)) ?? memoryDecisionBaseLabel(row),
      })),
    [labels, targets],
  );
  return (
    <View testID="save-memory-decision.target" style={styles.target}>
      {targets.length >= 2 && targets.length <= MAX_SEGMENTS && active ? (
        <SegmentedChoiceItem<string>
          title={t('memoryContext.memory.sheetSaveTo')}
          options={options}
          value={
            active.target.scope === 'account'
              ? 'account'
              : memoryDecisionTargetId(active.target)
          }
          onChange={choose}
          testIDPrefix="save-memory-decision.target"
          accessoryLayout="adaptive"
          showDivider={false}
          disabled={locked}
        />
      ) : targets.length > MAX_SEGMENTS ? (
        <DropdownMenu
          testID="save-memory-decision.targetMenu"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          items={options.map((option) => ({
            id: option.id,
            title: option.label,
            testID: `save-memory-decision.target:${option.id}`,
          }))}
          selectedId={
            active ? memoryDecisionTargetId(active.target) : undefined
          }
          onSelect={choose}
          search
          searchPlaceholder={t('common.search')}
          itemTrigger={{
            title: t('memoryContext.memory.sheetSaveTo'),
            itemProps: {
              accessoryLayout: 'adaptive',
              disabled: locked,
              showDivider: false,
            },
          }}
        />
      ) : null}
      {active ? (
        <TargetAudienceLine
          key={memoryDecisionTargetId(active.target)}
          row={active}
        />
      ) : null}
      {targetCoverage === 'partial' ? (
        <Text style={styles.meta}>
          {t('memoryContext.memory.sheetSaveToPartial')}
        </Text>
      ) : null}
    </View>
  );
}

function ChooserBody(
  props: Readonly<{ model: Model; natural: NaturalTarget }>,
) {
  const { model } = props;
  const { refreshTargets, targetStatus, targets, selectedTarget, selectTarget, review } = model;
  // The sheet opening is the demand: the finite read happens once, on first show.
  React.useEffect(() => {
    void refreshTargets();
  }, [refreshTargets]);
  // The source's natural destination is chosen for the person, so the line below it, a Saved
  // receipt and the save itself all speak about one explicit place. A review in flight stays put.
  const naturalId = props.natural.id;
  React.useEffect(() => {
    if (targetStatus !== 'ready' || selectedTarget || review || naturalId === null) return;
    const row = targets.find((candidate) => memoryDecisionTargetId(candidate.target) === naturalId);
    if (row) selectTarget(row.target);
  }, [naturalId, review, selectTarget, selectedTarget, targetStatus, targets]);
  if (targetStatus === 'unavailable') {
    return (
      <Text testID="save-memory-decision.targetUnavailable" style={styles.meta}>
        {t('memoryContext.memory.sheetSaveToUnavailable')}
      </Text>
    );
  }
  if (targetStatus !== 'ready' || targets.length < 1) {
    // A person's own memory is where a Discussion saves meanwhile; holding its row keeps the sheet from shifting on arrival.
    return naturalId === 'account' ? (
      <SegmentedChoiceItem<string>
        title={t('memoryContext.memory.sheetSaveTo')}
        options={[{ id: 'account', label: t('memoryContext.memory.sheetSaveToOnlyMe') }]}
        value="account"
        onChange={noop}
        testIDPrefix="save-memory-decision.target"
        accessoryLayout="adaptive"
        showDivider={false}
        disabled
      />
    ) : null;
  }
  return <TargetChoice model={model} natural={props.natural} />;
}

function SessionChooser(
  props: Readonly<{
    model: Model;
    session: Readonly<{ sessionId: string; serverId: string }>;
  }>,
) {
  const natural = useSessionNaturalTarget(props.session, props.model.targets);
  return <ChooserBody model={props.model} natural={natural} />;
}

/** "Save to": Only me and the Projects this person may write, with the real audience of the chosen memory. */
export function SaveMemoryDecisionTargetChooser(
  props: Readonly<{ model: Model }>,
) {
  const { model } = props;
  return model.sessionSource ? (
    <SessionChooser model={model} session={model.sessionSource} />
  ) : (
    <ChooserBody model={model} natural={{ id: 'account' }} />
  );
}

/** The chosen place's name for the header's one-line subtitle; null while it is the Action's own default. */
export function memoryDecisionChosenLabel(model: Model): string | null {
  const { selectedTarget, targets } = model;
  return selectedTarget ? (memoryDecisionTargetLabels(targets).get(memoryDecisionTargetId(selectedTarget)) ?? null) : null;
}

const styles = StyleSheet.create((theme) => ({
  target: { gap: theme.space.s6 },
  audience: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
  meta: { ...Typography.variant('meta'), color: theme.colors.text.secondary },
}));
