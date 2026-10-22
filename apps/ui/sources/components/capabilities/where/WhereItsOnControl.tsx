import * as React from 'react';
import { Platform, View, type TextStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
  HappierFieldBoxTrigger,
  HappierPressable,
  resolveHappierFieldBoxLabel,
  useHappierPageSection,
} from '@happier-dev/plugin-ui/presentation';
import type { ReachProjectionV1 } from '@happier-dev/protocol/reach/projectReachV1';
import type { ReachPlaceV1 } from '@happier-dev/protocol/reach/reachPlaceV1';
import type {
  ReachRuleV1,
  ReachRulesV1,
} from '@happier-dev/protocol/reach/reachRuleV1';
import {
  applyReachRulesChangeV1,
  normalizeReachRulesV1,
  reachRuleKeyV1,
  reachRulesToDraftsV1,
  resolveCreateReachV1,
  type ReachRulesChangeV1,
  type ReachRuleWriteV1,
} from '@happier-dev/protocol/reach/reachRulesChangeV1';

import { AgentCatalogIdentityIcon } from '@/agents/presentation/AgentCatalogIdentityIcon';
import type { SessionAgentCatalogIdentity } from '@/agents/registry/useSessionAgentCatalogIdentity';
import { AgentNameRun } from '@/components/capabilities/identity/AgentNameRun';
import { IconButton } from '@/components/ui/buttons/IconButton';
import {
  DropdownMenu,
  type DropdownMenuItem,
} from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveFieldBoxColors } from '@/components/ui/forms/fieldBox';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import {
  ExpandableItem,
  ExpandableItemCaret,
} from '@/components/ui/lists/ExpandableItem';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SectionContentRow } from '@/components/ui/lists/SectionContentRow';
import { SectionLeadingColumnProvider } from '@/components/ui/lists/sectionLeadingColumn';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { useWhereItsOnNames } from './useWhereItsOnNames';
import { joinList } from '@/utils/text/joinList';
import {
  describeReach,
  describeReachRule,
  foldMachineNames,
  sayWhereItsOn,
  type WhereItsOnNames,
  type WhereItsOnSentence,
} from './whereItsOnPresentation';

type ReplaceChange = Extract<ReachRulesChangeV1, { kind: 'replace' }>;
export type WhereItsOnChangeResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; message: string }>;

export type WhereItsOnControlProps = Readonly<{
  kind: 'skill' | 'mcp_server';
  /** From P2 `useReachRules(kind, itemId).rules`, or `useDraftReachRules(kind).rules` in add flows. */
  rules: ReachRulesV1;
  status: 'ready' | 'loading' | 'unavailable';
  /** From P2 `useReachProjection(kind, itemId)`; null while resolving (the consequence keeps its slot). */
  projection: readonly Readonly<ReachProjectionV1[number] & { projectKey?: string; agentInventoryComplete?: boolean }>[] | null;
  /** What "Add an exception" / "Add a place" offers. `online` is REACH's one predicate, read by the caller (C4). */
  places: Readonly<{
    agentIds: readonly string[];
    machines: readonly Readonly<{
      machineId: string;
      name: string;
      online: boolean | null;
    }>[];
    projects: readonly Readonly<{
      projectKey: string;
      name: string;
      machineCount: number;
    }>[];
  }>;
  /**
   * IR-80: which Agents can take this item. The caller joins it from the agent catalog projection (skills: P3
   * `resolveSkillPlanKindV1`; MCP: P1 `agentReceivesUserMcpServersV1`). Absent: every Agent takes it.
   */
  agentTakes?: (agentId: string) => 'full' | 'index' | 'none';
  /** One user change = one call carrying the whole next value (IR-20, D22: applied directly). */
  onChange: (change: ReplaceChange) => Promise<WhereItsOnChangeResult>;
  onUndo?: () => Promise<void>;
  /** 'section': the detail section (the closed sentence opens in place). 'pick': the compact form in add flows. */
  presentation: 'section' | 'pick';
  /** Why the viewer cannot edit; keeps the sentence and the consequence, drops every control. */
  readOnlyReason?: string;
  testID: string;
}>;

const takesEverything = () => 'full' as const;
const PLACE_RANK: Record<ReachPlaceV1['t'], number> = { allMachines: 0, machine: 1, project: 2, workspace: 3 };

function nextDrafts(
  rules: ReachRulesV1,
  writes: readonly ReachRuleWriteV1[],
): ReplaceChange {
  const ctx = { nowMs: Date.now(), newId: randomUUID };
  const next = writes.reduce<ReachRulesV1>(
    (current, write) =>
      applyReachRulesChangeV1(current, { kind: 'write', write }, ctx),
    rules,
  );
  return { kind: 'replace', rules: reachRulesToDraftsV1(next) };
}

const placeIcon = (place: ReachPlaceV1): IconName =>
  place.t === 'machine' ? 'desktop' : 'folder';

/** "On everywhere · except Gemini · except in [folder] client-site": the head emphasised, a project carrying its glyph. */
function SentenceText(
  props: Readonly<{
    sentence: WhereItsOnSentence;
    names: WhereItsOnNames;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const withPlaceGlyph = (
    text: string,
    place: ReachPlaceV1 | undefined,
    key: string,
  ) => {
    if (!place || (place.t !== 'project' && place.t !== 'workspace'))
      return text;
    const name =
      place.t === 'project'
        ? props.names.projectName(place.projectKey)
        : props.names.folderLabel(place.machineId, place.workspaceRoot);
    const at = text.lastIndexOf(name);
    if (at < 0) return text;
    return (
      <React.Fragment key={key}>
        {text.slice(0, at)}
        <Icon
          name="folder"
          size={ICON_SIZE.xs}
          color={theme.colors.text.secondary}
        />
        {` ${text.slice(at)}`}
      </React.Fragment>
    );
  };
  return (
    <Text variant="label" testID={props.testID} style={styles.sentence}>
      <Text
        variant="label"
        emphasis="semiBold"
        style={{ color: theme.colors.text.primary }}
      >
        {withPlaceGlyph(
          props.sentence.head,
          props.sentence.headStatement?.place,
          'head',
        )}
      </Text>
      {props.sentence.clauses.map((clause, index) => (
        <Text
          key={index}
          variant="label"
          style={{ color: theme.colors.text.secondary }}
        >
          <Text
            variant="label"
            style={{ color: theme.colors.text.tertiary }}
            aria-hidden
          >
            {'  ·  '}
          </Text>
          {withPlaceGlyph(clause.text, clause.place, `c${index}`)}
        </Text>
      ))}
    </Text>
  );
}

/** "Available to [Claude], [Codex] and [OpenCode] on MacBook Pro and nl2", then the notes. */
function ConsequenceLine(
  props: Readonly<{
    kind: WhereItsOnControlProps['kind'];
    projection: WhereItsOnControlProps['projection'];
    machines: WhereItsOnControlProps['places']['machines'];
    names: WhereItsOnNames;
    agentTakes: NonNullable<WhereItsOnControlProps['agentTakes']>;
    /** Whether any rule turns the item on. With none, it is known to be available nowhere, whatever machines report. */
    anyRuleOn: boolean;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const machines = React.useMemo(() => props.projection?.map(row => ({ machineId: row.machineId,
    agentIds: row.agents.filter(agent => agent.enabled).map(agent => agent.agentId) })) ?? [], [props.projection]);
  const consequence = props.projection === null ? null : describeReach(
    props.projection,
    props.machines,
    props.names,
    props.agentTakes,
    props.kind,
  );
  if (consequence === null || (consequence.availabilityUnknown && props.anyRuleOn)) {
    return (
      <Text
        variant="body"
        testID={props.testID}
        style={{ color: theme.colors.text.secondary }}
      >
        —
      </Text>
    );
  }
  const nowhere =
    consequence.availableAgentIds.length === 0 ||
    consequence.onlineMachineNames.length === 0;
  // The sentence is the translation's; the Agent names inside it carry their marks.
  const marker = '\u0002';
  const [before, after] = t('capabilities.where.available', {
    agents: marker,
    machines: joinList(foldMachineNames(consequence.onlineMachineNames).map((name) => `${NAME_OPEN}${name}${NAME_CLOSE}`)),
    projects: consequence.onlyProjectNames.length ? joinList(consequence.onlyProjectNames) : undefined,
  }).split(marker);
  return (
    <View testID={props.testID} style={styles.consequence} aria-live="polite">
      {nowhere ? (
        <Text variant="body" style={{ color: theme.colors.text.secondary }}>
          {t('capabilities.where.availableNowhere')}
        </Text>
      ) : (
        <Text variant="body" style={{ color: theme.colors.text.secondary }}>
          {withWholeNames(before ?? '')}
          <AgentNameRun
            agentIds={consequence.availableAgentIds}
            machines={machines}
            testID={`${props.testID}:agents`}
          />
          {withWholeNames(after ?? '')}
        </Text>
      )}
      {consequence.notes.map((note) => (
        <Text
          key={note}
          variant="meta"
          style={{ color: theme.colors.text.tertiary }}
        >
          {note}
        </Text>
      ))}
    </View>
  );
}

const NAME_OPEN = '\u0003';
const NAME_CLOSE = '\u0004';
// Web only (the text is CSS): a name stays whole, so the sentence wraps before it, never inside it.
const wholeName = Platform.select<TextStyle>({ web: { whiteSpace: 'nowrap' } as TextStyle });

/** The sentence's text with each marked machine name drawn unbreakable. */
function withWholeNames(text: string): React.ReactNode {
  return text.split(new RegExp(`${NAME_OPEN}(.*?)${NAME_CLOSE}`)).map((part, index) =>
    index % 2 === 1 ? <Text key={index} style={wholeName}>{part}</Text> : part,
  );
}

/** The sheet's own row hairline, full width, where the disclosure body ends. */
function SheetHairline() {
  const pageSection = useHappierPageSection();
  return <View style={[styles.bodyEnd, pageSection ? { backgroundColor: pageSection.rowDividerColor } : null]} />;
}

function RuleMark(
  props: Readonly<{
    rule: ReachRuleV1;
    identity: SessionAgentCatalogIdentity | undefined;
  }>,
) {
  const { theme } = useUnistyles();
  if (props.rule.target.t === 'allMachines' && props.identity) {
    return (
      <AgentCatalogIdentityIcon
        entry={props.identity.entry}
        machineId={null}
        serverId={null}
        current={props.identity.current}
        size={ICON_SIZE.md}
      />
    );
  }
  return (
    <Icon
      name={placeIcon(props.rule.target)}
      size={ICON_SIZE.md}
      color={theme.colors.text.secondary}
    />
  );
}

/**
 * "Where it's on", variant A (D18): the sentence, which opens in place into Everywhere On | Off, the rules under
 * "Turned on in" and "Except", and one add menu; the live consequence underneath. Every edit is one `replace`
 * computed with P2's `applyReachRulesChangeV1`; words come only from `whereItsOnPresentation`.
 */
export const WhereItsOnControl = React.memo(function WhereItsOnControl(
  props: WhereItsOnControlProps,
) {
  const { theme } = useUnistyles();
  const [expanded, setExpanded] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [failure, setFailure] = React.useState<Readonly<{
    change: ReplaceChange;
    message: string;
  }> | null>(null);
  const editable =
    props.readOnlyReason === undefined && props.status === 'ready';
  const rules = React.useMemo(
    () => normalizeReachRulesV1(props.rules),
    [props.rules],
  );

  const agentIds = React.useMemo(() => {
    const ids = new Set<string>(props.places.agentIds);
    for (const rule of rules)
      if (rule.agentId !== undefined) ids.add(rule.agentId);
    for (const row of props.projection ?? [])
      for (const agent of row.agents) ids.add(agent.agentId);
    return [...ids];
  }, [props.places.agentIds, rules, props.projection]);
  const { names, identityById } = useWhereItsOnNames({
    agentIds,
    machines: props.places.machines,
    projects: props.places.projects,
  });

  const sentence = React.useMemo(
    () => sayWhereItsOn(rules, names),
    [rules, names],
  );
  const base = rules.find(
    (rule) => rule.target.t === 'allMachines' && rule.agentId === undefined,
  );
  const baseOn = base?.enabled === true;
  // Broadest first (an Agent everywhere, then machines, projects, folders), as the sentence reads them.
  const ruleRows = rules.filter((rule) => rule !== base).sort((left, right) => PLACE_RANK[left.target.t] - PLACE_RANK[right.target.t]);
  const onRows = ruleRows.filter((rule) => rule.enabled);
  const offRows = ruleRows.filter((rule) => !rule.enabled);
  const exceptedAgentIds = offRows
    .filter(
      (rule) => rule.target.t === 'allMachines' && rule.agentId !== undefined,
    )
    .map((rule) => rule.agentId!);

  const commit = React.useCallback(
    async (change: ReplaceChange) => {
      setFailure(null);
      const result = await props.onChange(change);
      if (!result.ok) setFailure({ change, message: result.message });
    },
    [props.onChange],
  );
  const write = React.useCallback(
    (...writes: ReachRuleWriteV1[]) => {
      void commit(nextDrafts(rules, writes));
    },
    [commit, rules],
  );

  const addItems = React.useMemo<readonly DropdownMenuItem[]>(() => {
    const present = new Set(rules.map((rule) => reachRuleKeyV1(rule)));
    const has = (place: ReachPlaceV1, agentId?: string) =>
      present.has(
        reachRuleKeyV1({ target: place, ...(agentId ? { agentId } : {}) }),
      );
    const agentItems = (category: string) =>
      props.places.agentIds
        .filter((agentId) => !has({ t: 'allMachines' }, agentId))
        .map((agentId): DropdownMenuItem => {
          const identity = identityById.get(agentId);
          return {
            id: `agent:${agentId}`,
            category,
            title: names.agentName(agentId),
            testID: `${props.testID}:add:agent:${agentId}`,
            ...(identity
              ? {
                  icon: (
                    <AgentCatalogIdentityIcon
                      entry={identity.entry}
                      machineId={null}
                      serverId={null}
                      current={identity.current}
                      size={ICON_SIZE.sm}
                    />
                  ),
                }
              : {}),
          };
        });
    const machineItems = (category: string) =>
      props.places.machines
        .filter(
          (machine) => !has({ t: 'machine', machineId: machine.machineId }),
        )
        .map((machine): DropdownMenuItem => ({
          id: `machine:${machine.machineId}`,
          category,
          title: machine.name,
          testID: `${props.testID}:add:machine:${machine.machineId}`,
          icon: (
            <Icon
              name="desktop"
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />
          ),
          ...(machine.online
            ? {}
            : {
                rightElement: (
                  <Text
                    variant="meta"
                    style={{ color: theme.colors.text.tertiary }}
                  >
                    {t(machine.online === false ? 'capabilities.control.offline' : 'common.unknown')}
                  </Text>
                ),
              }),
        }));
    const projectItems = (category: string) =>
      props.places.projects
        .filter(
          (project) => !has({ t: 'project', projectKey: project.projectKey }),
        )
        .map((project): DropdownMenuItem => ({
          id: `project:${project.projectKey}`,
          category,
          title: project.name,
          testID: `${props.testID}:add:project:${project.projectKey}`,
          icon: (
            <Icon
              name="folder"
              size={ICON_SIZE.sm}
              color={theme.colors.text.secondary}
            />
          ),
          rightElement: (
            <Text
              variant="meta"
              style={{
                color: theme.colors.text.tertiary,
                fontVariant: ['tabular-nums'],
              }}
            >
              {t('capabilities.control.machineCount', {
                count: project.machineCount,
              })}
            </Text>
          ),
        }));
    // Under On everywhere the commonest exception is an Agent; under Off, a project (it follows you to every machine).
    return baseOn
      ? [
          ...agentItems(t('capabilities.control.menuAgent')),
          ...machineItems(t('capabilities.control.menuMachine')),
          ...projectItems(t('capabilities.control.menuProject')),
        ]
      : [
          ...projectItems(t('capabilities.control.menuProjectEverywhere')),
          ...machineItems(t('capabilities.control.menuMachine')),
          ...agentItems(t('capabilities.control.menuAgentEverywhere')),
        ];
  }, [rules, props.places, identityById, names, baseOn, props.testID, theme]);

  const onAdd = React.useCallback(
    (itemId: string) => {
      const [kindOfPlace, ...rest] = itemId.split(':');
      const id = rest.join(':');
      const state = baseOn ? ('off' as const) : ('on' as const);
      if (kindOfPlace === 'agent')
        write({ place: { t: 'allMachines' }, agentId: id, state });
      else if (kindOfPlace === 'machine')
        write({ place: { t: 'machine', machineId: id }, state });
      else if (kindOfPlace === 'project')
        write({ place: { t: 'project', projectKey: id }, state });
    },
    [baseOn, write],
  );

  const ruleRow = (rule: ReachRuleV1) => {
    const described = describeReachRule(rule, names, props.kind);
    const key = reachRuleKeyV1(rule);
    const testID = `${props.testID}:rule:${key}`;
    // A place turned on can be narrowed to one Agent; the select swaps the qualifier in one change.
    const narrowable = rule.enabled && rule.target.t !== 'allMachines';
    const placeTitle =
      rule.target.t === 'allMachines'
        ? described.title
        : names[rule.target.t === 'machine' ? 'machineName' : 'projectName'](
            rule.target.t === 'machine'
              ? rule.target.machineId
              : rule.target.t === 'project'
                ? rule.target.projectKey
                : rule.target.machineId,
          );
    const agentSelect =
      narrowable && editable ? (
        <RuleAgentSelect
          rule={rule}
          agentIds={props.places.agentIds}
          names={names}
          identityById={identityById}
          placeTitle={placeTitle}
          testID={`${testID}:agents`}
          onSelect={(agentId) =>
            write(
              {
                place: rule.target,
                ...(rule.agentId ? { agentId: rule.agentId } : {}),
                state: 'inherit',
              },
              {
                place: rule.target,
                ...(agentId ? { agentId } : {}),
                state: 'on',
              },
            )
          }
        />
      ) : null;
    const remove = editable ? (
      <IconButton
        iconName="x"
        variant="plain"
        accessibilityLabel={t('capabilities.control.remove', {
          target: described.title,
        })}
        testID={`${testID}:remove`}
        onPress={() =>
          write({
            place: rule.target,
            ...(rule.agentId ? { agentId: rule.agentId } : {}),
            state: 'inherit',
          })
        }
      />
    ) : null;
    // D33: a place turned on for all agents never re-enables an excepted Agent there; say so under the row.
    const staysOff =
      rule.enabled &&
      rule.agentId === undefined &&
      rule.target.t !== 'allMachines'
        ? exceptedAgentIds.filter(
            (agentId) =>
              !rules.some(
                (other) =>
                  other.agentId === agentId &&
                  other.enabled &&
                  reachRuleKeyV1({ target: other.target }) ===
                    reachRuleKeyV1({ target: rule.target }),
              ),
          )
        : [];
    return (
      <Item
        key={key}
        testID={testID}
        title={
          rule.agentId !== undefined && rule.target.t !== 'allMachines'
            ? placeTitle
            : described.title
        }
        subtitle={described.effect}
        icon={
          <RuleMark
            rule={rule}
            identity={rule.agentId ? identityById.get(rule.agentId) : undefined}
          />
        }
        // A lone Remove is a narrow control and stays beside the label; with the agents select the pair moves beneath on a phone.
        {...(agentSelect ? { accessoryLayout: 'adaptive' as const } : {})}
        rightElement={
          agentSelect || remove ? (
            <View style={styles.ruleControls}>
              {agentSelect}
              {remove}
            </View>
          ) : undefined
        }
        {...(staysOff.length > 0
          ? {
              bottomElement: (
                <Text
                  variant="meta"
                  style={{ color: theme.colors.text.tertiary }}
                  testID={`${testID}:staysOff`}
                >
                  {t('capabilities.control.staysOff', {
                    agents: staysOff.map(names.agentName).join(', '),
                  })}
                </Text>
              ),
              bottomElementInset: 'text' as const,
            }
          : {})}
        showChevron={false}
        showDivider={false}
      />
    );
  };

  const group = (title: string, rows: readonly ReachRuleV1[], key: string) =>
    rows.length === 0 ? null : (
      <View key={key} testID={`${props.testID}:${key}`}>
        <CollectionListGroupLabel title={title} />
        {rows.map(ruleRow)}
      </View>
    );

  const body = (
    <View testID={`${props.testID}:body`}>
      <SheetHairline />
      <SegmentedChoiceItem
        testID={`${props.testID}:everywhere`}
        testIDPrefix={`${props.testID}:everywhere`}
        title={t('capabilities.where.everywhere')}
        subtitle={t(
          baseOn
            ? 'capabilities.where.effect.everywhereOn'
            : 'capabilities.where.effect.everywhereOff',
        )}
        options={[
          { id: 'on', label: t('capabilities.control.on') },
          { id: 'off', label: t('capabilities.control.off') },
        ]}
        value={baseOn ? 'on' : 'off'}
        disabled={!editable}
        onChange={(next) => write({ place: { t: 'allMachines' }, state: next })}
        showDivider
      />
      {/* The rules are their own list: their marks align the rule titles without moving the sentence or Everywhere. */}
      <SectionLeadingColumnProvider>
      {baseOn
        ? [
            group(t('capabilities.control.except'), offRows, 'except'),
            group(t('capabilities.control.turnedOnIn'), onRows, 'turnedOnIn'),
          ]
        : [
            group(t('capabilities.control.turnedOnIn'), onRows, 'turnedOnIn'),
            group(t('capabilities.control.except'), offRows, 'except'),
          ]}
      {!baseOn && onRows.length === 0 ? (
        <View>
          <CollectionListGroupLabel
            title={t('capabilities.control.turnedOnIn')}
          />
          <Text
            variant="body"
            style={[styles.nowhere, { color: theme.colors.text.secondary }]}
            testID={`${props.testID}:nowhere`}
          >
            {t('capabilities.control.nowhereYet')}
          </Text>
        </View>
      ) : null}
      </SectionLeadingColumnProvider>
      {editable && addItems.length > 0 ? (
        <View style={styles.add}>
          <DropdownMenu
            testID={`${props.testID}:addMenu`}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            items={addItems}
            onSelect={onAdd}
            showCategoryTitles
            matchTriggerWidth={false}
            rowKind="item"
            popoverPhonePresentation="sheet"
            popoverAccessibilityLabel={t(
              baseOn
                ? 'capabilities.control.addException'
                : 'capabilities.control.addPlace',
            )}
            trigger={({ toggle, open }) => (
              <SectionActionButton
                testID={`${props.testID}:add`}
                icon="plus"
                title={t(
                  baseOn
                    ? 'capabilities.control.addException'
                    : 'capabilities.control.addPlace',
                )}
                expanded={open}
                onPress={toggle}
              />
            )}
          />
        </View>
      ) : props.readOnlyReason !== undefined ? (
        <Text
          variant="meta"
          style={[styles.nowhere, { color: theme.colors.text.tertiary }]}
          testID={`${props.testID}:readOnly`}
        >
          {props.readOnlyReason}
        </Text>
      ) : null}
      <SheetHairline />
    </View>
  );

  const sheet = (
    <>
      <ExpandableItem
        testID={`${props.testID}:disclosure`}
        expanded={expanded}
        onExpandedChange={setExpanded}
        // The body ends on the sheet's own row hairline (below), so the consequence reads as the sheet's last row.
        showDivider={false}
        header={({ headerProps, expanded: open }) => (
          <Item
            {...(headerProps as Readonly<Record<string, unknown>>)}
            testID={`${props.testID}:sentence`}
            title={
              <SentenceText
                sentence={sentence}
                names={names}
                testID={`${props.testID}:sentenceText`}
              />
            }
            rightElement={
              props.presentation === 'pick' && !open ? (
                <Text
                  variant="label"
                  style={{
                    color:
                      theme.colors.text.link ?? theme.colors.text.secondary,
                  }}
                >
                  {t('capabilities.control.change')}
                </Text>
              ) : (
                <ExpandableItemCaret expanded={open} />
              )
            }
            showChevron={false}
          />
        )}
      >
        {expanded ? body : null}
      </ExpandableItem>
      <SectionContentRow
        testID={`${props.testID}:consequenceRow`}
        showDivider={failure !== null}
        // Closed, the consequence finishes the sentence's row (one card, as the lab draws it); open, it follows the rules.
        continuesRow={!expanded}
      >
        <ConsequenceLine
          kind={props.kind}
          projection={props.projection}
          machines={props.places.machines}
          names={names}
          agentTakes={props.agentTakes ?? takesEverything}
          anyRuleOn={rules.some((rule) => rule.enabled)}
          testID={`${props.testID}:consequence`}
        />
      </SectionContentRow>
      {failure ? (
        <SurfaceStateCard
          testID={`${props.testID}:error`}
          kind="error"
          size="line"
          title={t('capabilities.control.changeFailed')}
          diagnosticCode={failure.message}
          action={{
            label: t('capabilities.status.fix.tryAgain'),
            onPress: () => void commit(failure.change),
          }}
        />
      ) : null}
    </>
  );

  // A section of its page in both forms: the compact add-flow form carries the same title, on the same edge as the
  // sections around it, and leaves the description to the detail's own copy.
  return (
    <ItemGroup
      testID={props.testID}
      title={t('capabilities.control.title')}
      {...(props.presentation === 'section' ? { description: t('capabilities.control.description') } : {})}
    >
      {sheet}
    </ItemGroup>
  );
});

function RuleAgentSelect(
  props: Readonly<{
    rule: ReachRuleV1;
    agentIds: readonly string[];
    names: WhereItsOnNames;
    identityById: ReadonlyMap<string, SessionAgentCatalogIdentity>;
    placeTitle: string;
    onSelect: (agentId: string | null) => void;
    testID: string;
  }>,
) {
  const { theme } = useUnistyles();
  const [open, setOpen] = React.useState(false);
  const selected =
    props.rule.agentId === undefined ? undefined : props.identityById.get(props.rule.agentId);
  const items = React.useMemo<readonly DropdownMenuItem[]>(
    () => [
      {
        id: '*',
        title: t('capabilities.control.allAgents'),
        checked: props.rule.agentId === undefined,
        testID: `${props.testID}:all`,
      },
      ...props.agentIds.map((agentId): DropdownMenuItem => {
        const identity = props.identityById.get(agentId);
        return {
          id: agentId,
          title: props.names.agentName(agentId),
          checked: props.rule.agentId === agentId,
          testID: `${props.testID}:${agentId}`,
          ...(identity
            ? {
                icon: (
                  <AgentCatalogIdentityIcon
                    entry={identity.entry}
                    machineId={null}
                    serverId={null}
                    current={identity.current}
                    size={ICON_SIZE.sm}
                  />
                ),
              }
            : {}),
        };
      }),
    ],
    [
      props.agentIds,
      props.identityById,
      props.names,
      props.rule.agentId,
      props.testID,
    ],
  );
  const label =
    props.rule.agentId === undefined
      ? t('capabilities.control.allAgents')
      : t('capabilities.control.agentOnly', {
          agent: props.names.agentName(props.rule.agentId),
        });
  const fieldColors = resolveFieldBoxColors(theme);
  const fieldLabel = resolveHappierFieldBoxLabel({ value: label, placeholder: label, colors: fieldColors });
  return (
    <DropdownMenu
      testID={props.testID}
      open={open}
      onOpenChange={setOpen}
      items={items}
      selectedId={props.rule.agentId ?? '*'}
      onSelect={(id) => {
        if (id === (props.rule.agentId ?? '*')) return;
        props.onSelect(id === '*' ? null : id);
      }}
      matchTriggerWidth={false}
      popoverPhonePresentation="sheet"
      popoverAccessibilityLabel={t('capabilities.control.whichAgents', {
        place: props.placeTitle,
      })}
      trigger={({ toggle, open: isOpen }) => (
        <HappierPressable
          testID={`${props.testID}:trigger`}
          onPress={toggle}
          accessibilityRole="button"
          accessibilityLabel={t('capabilities.control.whichAgents', { place: props.placeTitle })}
          expanded={isOpen}
          hasPopup="menu"
        >
          <HappierFieldBoxTrigger
            colors={fieldColors}
            span="intrinsic"
            {...(selected ? { leading: <AgentCatalogIdentityIcon entry={selected.entry} machineId={null} serverId={null} current={selected.current} size={ICON_SIZE.xs} /> } : {})}
            trailing={<Icon name={isOpen ? 'caret-up' : 'caret-down'} size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
          >
            <Text style={fieldLabel.style} numberOfLines={1}>{label}</Text>
          </HappierFieldBoxTrigger>
        </HappierPressable>
      )}
    />
  );
}

/**
 * Add flows before the item exists (IR-20): a local draft that starts from P2's create-time default and the
 * create Action's `where` (undefined until the person changes the pick, then the last `replace`).
 */
export function useDraftReachRules(kind: 'skill' | 'mcp_server'): Readonly<{
  rules: ReachRulesV1;
  where: ReachRulesChangeV1 | undefined;
  onChange: WhereItsOnControlProps['onChange'];
}> {
  const [state, setState] = React.useState<
    Readonly<{ rules: ReachRulesV1; where: ReachRulesChangeV1 | undefined }>
  >(() => {
    const created = resolveCreateReachV1({
      kind,
      caller: { surface: 'ui' },
      ctx: { nowMs: Date.now(), newId: randomUUID },
    });
    return { rules: created.ok ? created.rules : [], where: undefined };
  });
  const onChange = React.useCallback<WhereItsOnControlProps['onChange']>(
    async (change) => {
      setState((current) => ({
        rules: applyReachRulesChangeV1(current.rules, change, {
          nowMs: Date.now(),
          newId: randomUUID,
        }),
        where: change,
      }));
      return { ok: true };
    },
    [],
  );
  return { rules: state.rules, where: state.where, onChange };
}

const styles = StyleSheet.create((theme) => ({
  sentence: { flexShrink: 1 },
  bodyEnd: { height: StyleSheet.hairlineWidth },
  consequence: { gap: theme.space.s4 },
  ruleControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  nowhere: {
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s8,
  },
  add: {
    paddingHorizontal: theme.space.s12,
    paddingTop: theme.space.s4,
    paddingBottom: theme.space.s12,
    alignItems: 'flex-start',
  },
}));
