import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { MemoryScopeTargetV1 } from '@happier-dev/protocol/actions/executor/types';

import { resolveWorkspaceRefDisplayName } from '@/components/projects/resolveWorkspaceRefDisplayName';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon } from '@/components/ui/icons/Icon';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
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

/** Display-only default. A Session's qualified destination remains owned by its save Action. */
type NaturalTarget = Readonly<{ id: string | null }>;

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
      {targets.length >= 2 && targets.length <= MAX_SEGMENTS ? (
        <SegmentedChoiceItem<string>
          title={t('memoryContext.memory.sheetSaveTo')}
          options={options}
          value={active ? memoryDecisionTargetId(active.target) : ''}
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
  const { refreshTargets, targetStatus, targets } = model;
  // The sheet opening is the demand: the finite read happens once, on first show.
  React.useEffect(() => {
    void refreshTargets();
  }, [refreshTargets]);
  // Loading choices must not turn a display default into an explicit write destination.
  // Only a person's choice calls selectTarget; otherwise save retains the Session/Account owner.
  const naturalId = props.natural.id;
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

/** "Save to": Only me and the Projects this person may write, with the real audience of the chosen memory. */
export function SaveMemoryDecisionTargetChooser(
  props: Readonly<{ model: Model }>,
) {
  const { model } = props;
  return <ChooserBody model={model} natural={{ id: model.sessionSource ? null : 'account' }} />;
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
