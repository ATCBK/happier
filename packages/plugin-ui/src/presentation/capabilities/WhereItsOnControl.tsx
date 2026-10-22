import * as React from 'react';
import { Platform, StyleSheet, View, type TextStyle } from 'react-native';
import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import { useHappierPageSection } from '../layout/PageSection.js';
import {
  describeHappierReach,
  describeHappierReachRule,
  foldHappierMachineNames,
  happierWhereItsOnAgentNames,
  sayHappierWhereItsOn,
  type HappierReachChange,
  type HappierReachPlace,
  type HappierReachRule,
  type HappierReachRuleDraft,
  type HappierReachWrite,
  type HappierWhereItsOnGroup,
  type HappierWhereItsOnItemKind,
  type HappierWhereItsOnLabels,
  type HappierWhereItsOnNames,
  type HappierWhereItsOnProjectionRow,
  type HappierWhereItsOnSentence,
} from './whereItsOn.js';

export type HappierWhereItsOnReplaceChange = Extract<HappierReachChange, { kind: 'replace' }>;

/**
 * Happier's reach rule engine, which the control writes through: grouping and precedence, rule identity, applying a
 * change, the create-time default. It is the reach owner's, not this control's; the caller binds it.
 */
export type HappierWhereItsOnReach = Readonly<{
  group: HappierWhereItsOnGroup;
  /** Old stored duplicates collapse to the precedence owner's winner. */
  normalize: (rules: readonly HappierReachRule[]) => readonly HappierReachRule[];
  key: (rule: Readonly<{ target: HappierReachPlace; agentId?: string | undefined }>) => string;
  apply: (rules: readonly HappierReachRule[], change: HappierReachChange) => readonly HappierReachRule[];
  toDrafts: (rules: readonly HappierReachRule[]) => readonly HappierReachRuleDraft[];
  /** A new item's rules before the person picks. */
  createDefault: (kind: HappierWhereItsOnItemKind) => readonly HappierReachRule[];
}>;
export type HappierWhereItsOnChangeResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; message: string }>;

export type HappierWhereItsOnPlaces = Readonly<{
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

/** The control's own words, beside the sentence words (`HappierWhereItsOnLabels`). */
export type HappierWhereItsOnControlLabels = HappierWhereItsOnLabels &
  Readonly<{
    control: Readonly<{
      title: () => string;
      description: () => string;
      on: () => string;
      off: () => string;
      turnedOnIn: () => string;
      except: () => string;
      nowhereYet: () => string;
      addException: () => string;
      addPlace: () => string;
      menuAgent: () => string;
      menuAgentEverywhere: () => string;
      menuMachine: () => string;
      menuProject: () => string;
      menuProjectEverywhere: () => string;
      /** A machine whose reachability is known to be offline. */
      offline: () => string;
      /** A machine whose reachability is not known yet. */
      unknown: () => string;
      machineCount: (count: number) => string;
      allAgents: () => string;
      agentOnly: (agent: string) => string;
      whichAgents: (place: string) => string;
      remove: (target: string) => string;
      staysOff: (agents: string) => string;
      change: () => string;
      changeFailed: () => string;
      tryAgain: () => string;
    }>;
  }>;

type TextTone = 'primary' | 'secondary' | 'tertiary';
export type HappierWhereItsOnTextProps = Readonly<{
  variant: 'label' | 'body' | 'meta';
  tone: TextTone;
  emphasis?: 'semiBold';
  tabular?: boolean;
  /** Decorative (a separator dot). */
  hidden?: boolean;
  style?: TextStyle;
  testID?: string;
  children?: React.ReactNode;
}>;

/** A choice in an add or Agent menu; its mark is an Agent's identity or a place glyph. */
export type HappierWhereItsOnMenuItem = Readonly<{
  id: string;
  title: string;
  testID: string;
  mark?:
    | Readonly<{ kind: 'agent'; agentId: string }>
    | Readonly<{ kind: 'icon'; name: 'desktop' | 'folder' }>;
  /** Quiet meta after the title ("offline", "2 machines"). */
  trailing?: Readonly<{ text: string; tabular?: boolean }>;
  checked?: boolean;
}>;

/**
 * The primitives the control draws with. Happier binds its own settings primitives; the public adapter binds the
 * public plugin components. The composition (what is shown, in which order, what each control writes) stays here.
 */
export type HappierWhereItsOnHost = Readonly<{
  /** A page section: title, an optional description above one sheet. */
  Section: React.ComponentType<
    Readonly<{
      testID: string;
      title: string;
      description?: string;
      children: React.ReactNode;
    }>
  >;
  /** The sentence row, which opens the rules in place; `changeLabel` replaces the caret while closed (add flows). */
  Disclosure: React.ComponentType<
    Readonly<{
      testID: string;
      rowTestID: string;
      /** The section injects its row divider; the sentence row draws none (the consequence continues it). */
      showDivider?: boolean;
      expanded: boolean;
      onExpandedChange: (expanded: boolean) => void;
      title: React.ReactNode;
      changeLabel?: string;
      children: React.ReactNode;
    }>
  >;
  /** The Everywhere On | Off row. */
  Everywhere: React.ComponentType<
    Readonly<{
      testID: string;
      title: string;
      subtitle: string;
      options: readonly Readonly<{ id: 'on' | 'off'; label: string }>[];
      value: 'on' | 'off';
      disabled: boolean;
      onChange: (value: 'on' | 'off') => void;
    }>
  >;
  /** The rule rows' own list, so their marks align their titles. */
  RuleList: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
  GroupLabel: React.ComponentType<Readonly<{ title: string }>>;
  /** A rule: its mark, title, effect, its controls and a note under it. */
  Rule: React.ComponentType<
    Readonly<{
      testID: string;
      title: string;
      subtitle: string;
      mark: React.ReactNode;
      /** The controls move beneath the label on a phone (the Agent select is wide). */
      wideControls: boolean;
      controls?: React.ReactNode;
      note?: React.ReactNode;
    }>
  >;
  RemoveButton: React.ComponentType<
    Readonly<{
      testID: string;
      accessibilityLabel: string;
      onPress: () => void;
    }>
  >;
  /** "Add an exception": a section action that opens a menu of grouped choices. */
  AddMenu: React.ComponentType<
    Readonly<{
      testID: string;
      title: string;
      groups: readonly Readonly<{
        title: string;
        items: readonly HappierWhereItsOnMenuItem[];
      }>[];
      onSelect: (id: string) => void;
    }>
  >;
  /** A place rule's "All agents | Claude only" field select. */
  AgentSelect: React.ComponentType<
    Readonly<{
      testID: string;
      label: string;
      accessibilityLabel: string;
      selectedAgentId: string | null;
      items: readonly HappierWhereItsOnMenuItem[];
      selectedId: string;
      onSelect: (id: string) => void;
    }>
  >;
  /** The consequence's row: it continues the sentence's row while the rules are closed. */
  ConsequenceRow: React.ComponentType<
    Readonly<{
      testID: string;
      continuesRow: boolean;
      showDivider: boolean;
      children: React.ReactNode;
    }>
  >;
  ErrorLine: React.ComponentType<
    Readonly<{
      testID: string;
      showDivider?: boolean;
      title: string;
      diagnostic: string;
      actionLabel: string;
      onAction: () => void;
    }>
  >;
  Text: React.ComponentType<HappierWhereItsOnTextProps>;
  /** A place glyph inline in the sentence ("[folder] client-site"). */
  PlaceGlyph: React.ComponentType<
    Readonly<{ name: 'desktop' | 'folder'; size: 'xs' | 'sm' | 'md' }>
  >;
  /** An Agent's identity mark; null when the Agent has no known identity. */
  AgentMark: React.ComponentType<
    Readonly<{ agentId: string; size: 'xs' | 'sm' | 'md' }>
  >;
  /** The available Agents in the consequence sentence, as names (with marks when the caller has them). */
  AgentNames: React.ComponentType<
    Readonly<{
      agentIds: readonly string[];
      machines: readonly Readonly<{
        machineId: string;
        agentIds: readonly string[];
      }>[];
      testID: string;
    }>
  >;
  /** Whether an Agent has an identity mark (rules for an Agent everywhere draw it instead of a place glyph). */
  hasAgentMark: (agentId: string) => boolean;
}>;

export type HappierWhereItsOnControlProps = Readonly<{
  kind: HappierWhereItsOnItemKind;
  rules: readonly HappierReachRule[];
  status: 'ready' | 'loading' | 'unavailable';
  /** The rules' live reach per machine; null while resolving (the consequence keeps its slot). */
  projection: readonly HappierWhereItsOnProjectionRow[] | null;
  /** What "Add an exception" / "Add a place" offers; `online` is the caller's reachability. */
  places: HappierWhereItsOnPlaces;
  /** Which Agents can take this item. Absent: every Agent takes it. */
  agentTakes?: (agentId: string) => 'full' | 'index' | 'none';
  /** One change = one call carrying the whole next value. */
  onChange: (
    change: HappierWhereItsOnReplaceChange,
  ) => Promise<HappierWhereItsOnChangeResult>;
  /** 'section': a detail page's section (the closed sentence opens in place). 'pick': the compact form in add flows. */
  presentation: 'section' | 'pick';
  /** Why the viewer cannot edit; keeps the sentence and the consequence, drops every control. */
  readOnlyReason?: string;
  testID: string;
  names: HappierWhereItsOnNames;
  labels: HappierWhereItsOnControlLabels;
  host: HappierWhereItsOnHost;
  reach: HappierWhereItsOnReach;
  /** The caller's spacing steps (a compact density tightens them). */
  space?: Readonly<Record<'s4' | 's8' | 's12' | 's16', number>>;
}>;

const takesEverything = () => 'full' as const;
const PLACE_RANK: Record<HappierReachPlace['t'], number> = {
  allMachines: 0,
  machine: 1,
  project: 2,
  workspace: 3,
};

function nextDrafts(
  reach: HappierWhereItsOnReach,
  rules: readonly HappierReachRule[],
  writes: readonly HappierReachWrite[],
): HappierWhereItsOnReplaceChange {
  const next = writes.reduce<readonly HappierReachRule[]>(
    (current, write) => reach.apply(current, { kind: 'write', write }),
    rules,
  );
  return { kind: 'replace', rules: reach.toDrafts(next) };
}

/** Every Agent the control may name: the offered ones, the ones rules name, and the ones the projection reports. */
export function collectHappierWhereItsOnAgentIds(
  agentIds: readonly string[],
  rules: readonly HappierReachRule[],
  projection: readonly HappierWhereItsOnProjectionRow[] | null,
): readonly string[] {
  const ids = new Set<string>(agentIds);
  for (const rule of rules)
    if (rule.agentId !== undefined) ids.add(rule.agentId);
  for (const row of projection ?? [])
    for (const agent of row.agents) ids.add(agent.agentId);
  return [...ids];
}

/**
 * Add flows before the item exists: a local draft that starts from the reach owner's create-time default and the
 * create call's `where` (undefined until the person changes the pick, then the last `replace`).
 */
export function useHappierWhereItsOnDraft(
  kind: HappierWhereItsOnItemKind,
  reach: HappierWhereItsOnReach,
): Readonly<{
  rules: readonly HappierReachRule[];
  where: HappierReachChange | undefined;
  onChange: HappierWhereItsOnControlProps['onChange'];
}> {
  const [state, setState] = React.useState<
    Readonly<{ rules: readonly HappierReachRule[]; where: HappierReachChange | undefined }>
  >(() => ({ rules: reach.createDefault(kind), where: undefined }));
  const onChange = React.useCallback<HappierWhereItsOnControlProps['onChange']>(
    async (change) => {
      setState((current) => ({ rules: reach.apply(current.rules, change), where: change }));
      return { ok: true };
    },
    [reach],
  );
  return { rules: state.rules, where: state.where, onChange };
}

/** "On everywhere · except Gemini · except in [folder] client-site": the head emphasised, a project carrying its glyph. */
function SentenceText(
  props: Readonly<{
    sentence: HappierWhereItsOnSentence;
    names: HappierWhereItsOnNames;
    host: HappierWhereItsOnHost;
    testID: string;
  }>,
) {
  const { Text, PlaceGlyph } = props.host;
  const withPlaceGlyph = (
    text: string,
    place: HappierReachPlace | undefined,
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
        <PlaceGlyph name="folder" size="xs" />
        {` ${text.slice(at)}`}
      </React.Fragment>
    );
  };
  return (
    <Text
      variant="label"
      tone="primary"
      testID={props.testID}
      style={SENTENCE}
    >
      <Text variant="label" tone="primary" emphasis="semiBold">
        {withPlaceGlyph(
          props.sentence.head,
          props.sentence.headStatement?.place,
          'head',
        )}
      </Text>
      {props.sentence.clauses.map((clause, index) => (
        <Text key={index} variant="label" tone="secondary">
          <Text variant="label" tone="tertiary" hidden>
            {'  ·  '}
          </Text>
          {withPlaceGlyph(clause.text, clause.place, `c${index}`)}
        </Text>
      ))}
    </Text>
  );
}

const NAME_OPEN = '\u0003';
const NAME_CLOSE = '\u0004';
// Web only (the text is CSS): a name stays whole, so the sentence wraps before it, never inside it.
const WHOLE_NAME = Platform.select<TextStyle>({
  web: { whiteSpace: 'nowrap' } as TextStyle,
});

/** "Available to [Claude], [Codex] and [OpenCode] on MacBook Pro and nl2", then the notes. */
function ConsequenceLine(
  props: Readonly<{
    kind: HappierWhereItsOnItemKind;
    projection: HappierWhereItsOnControlProps['projection'];
    machines: HappierWhereItsOnPlaces['machines'];
    names: HappierWhereItsOnNames;
    labels: HappierWhereItsOnControlLabels;
    host: HappierWhereItsOnHost;
    agentTakes: (agentId: string) => 'full' | 'index' | 'none';
    /** Whether any rule turns the item on. With none, it is known to be available nowhere, whatever machines report. */
    anyRuleOn: boolean;
    gap: number;
    testID: string;
  }>,
) {
  const { Text, AgentNames } = props.host;
  const machines = React.useMemo(
    () =>
      props.projection?.map((row) => ({
        machineId: row.machineId,
        agentIds: row.agents
          .filter((agent) => agent.enabled)
          .map((agent) => agent.agentId),
      })) ?? [],
    [props.projection],
  );
  const consequence =
    props.projection === null
      ? null
      : describeHappierReach(
          props.projection,
          props.machines,
          props.names,
          props.agentTakes,
          props.kind,
          props.labels,
        );
  if (
    consequence === null ||
    (consequence.availabilityUnknown && props.anyRuleOn)
  ) {
    return (
      <Text variant="body" tone="secondary" testID={props.testID}>
        —
      </Text>
    );
  }
  const nowhere =
    consequence.availableAgentIds.length === 0 ||
    consequence.onlineMachineNames.length === 0;
  // The sentence is the caller's translation; the Agent names inside it are drawn by the host (with their marks).
  const marker = '\u0002';
  const [before, after] = props.labels.where
    .available({
      agents: marker,
      machines: props.labels.joinList(
        foldHappierMachineNames(
          consequence.onlineMachineNames,
          props.labels,
        ).map((name) => `${NAME_OPEN}${name}${NAME_CLOSE}`),
      ),
      ...(consequence.onlyProjectNames.length
        ? { projects: props.labels.joinList(consequence.onlyProjectNames) }
        : {}),
    })
    .split(marker);
  const withWholeNames = (text: string): React.ReactNode =>
    text
      .split(new RegExp(`${NAME_OPEN}(.*?)${NAME_CLOSE}`))
      .map((part, index) =>
        index % 2 === 1 ? (
          <Text
            key={index}
            variant="body"
            tone="secondary"
            {...(WHOLE_NAME ? { style: WHOLE_NAME } : {})}
          >
            {part}
          </Text>
        ) : (
          part
        ),
      );
  return (
    <View testID={props.testID} style={{ gap: props.gap }} aria-live="polite">
      {nowhere ? (
        <Text variant="body" tone="secondary">
          {props.labels.where.availableNowhere()}
        </Text>
      ) : (
        <Text variant="body" tone="secondary">
          {withWholeNames(before ?? '')}
          <AgentNames
            agentIds={consequence.availableAgentIds}
            machines={machines}
            testID={`${props.testID}:agents`}
          />
          {withWholeNames(after ?? '')}
        </Text>
      )}
      {consequence.notes.map((note) => (
        <Text key={note} variant="meta" tone="tertiary">
          {note}
        </Text>
      ))}
    </View>
  );
}

/** The sheet's own row hairline, full width, where the disclosure body ends. */
function SheetHairline() {
  const pageSection = useHappierPageSection();
  return (
    <View
      style={[
        HAIRLINE,
        pageSection ? { backgroundColor: pageSection.rowDividerColor } : null,
      ]}
    />
  );
}

/**
 * "Where it's on" (Capabilities D18): the sentence, which opens in place into Everywhere On | Off, the rules under
 * "Turned on in" and "Except", and one add menu; the live consequence underneath. Every edit is one `replace`
 * computed with the caller's reach engine; words come only from `whereItsOn`.
 */
export const HappierWhereItsOnControl = React.memo(
  function HappierWhereItsOnControl(props: HappierWhereItsOnControlProps) {
    const { names, labels, host, reach } = props;
    const words = labels.control;
    const space = props.space ?? HAPPIER_SPACE_STEPS;
    const [expanded, setExpanded] = React.useState(false);
    const [failure, setFailure] = React.useState<Readonly<{
      change: HappierWhereItsOnReplaceChange;
      message: string;
    }> | null>(null);
    const editable =
      props.readOnlyReason === undefined && props.status === 'ready';
    const rules = React.useMemo(
      () => reach.normalize(props.rules),
      [reach, props.rules],
    );

    const sentence = React.useMemo(
      () => sayHappierWhereItsOn(rules, names, labels, reach.group),
      [rules, names, labels, reach],
    );
    const base = rules.find(
      (rule) => rule.target.t === 'allMachines' && rule.agentId === undefined,
    );
    const baseOn = base?.enabled === true;
    // Broadest first (an Agent everywhere, then machines, projects, folders), as the sentence reads them.
    const ruleRows = rules
      .filter((rule) => rule !== base)
      .sort(
        (left, right) => PLACE_RANK[left.target.t] - PLACE_RANK[right.target.t],
      );
    const onRows = ruleRows.filter((rule) => rule.enabled);
    const offRows = ruleRows.filter((rule) => !rule.enabled);
    const exceptedAgentIds = offRows
      .filter(
        (rule) => rule.target.t === 'allMachines' && rule.agentId !== undefined,
      )
      .map((rule) => rule.agentId!);

    const { onChange } = props;
    const commit = React.useCallback(
      async (change: HappierWhereItsOnReplaceChange) => {
        setFailure(null);
        const result = await onChange(change);
        if (!result.ok) setFailure({ change, message: result.message });
      },
      [onChange],
    );
    const write = React.useCallback(
      (...writes: HappierReachWrite[]) => {
        void commit(nextDrafts(reach, rules, writes));
      },
      [commit, reach, rules],
    );

    const addGroups = React.useMemo(() => {
      const present = new Set(rules.map((rule) => reach.key(rule)));
      const has = (place: HappierReachPlace, agentId?: string) =>
        present.has(
          reach.key({ target: place, ...(agentId ? { agentId } : {}) }),
        );
      const agentItems = props.places.agentIds
        .filter((agentId) => !has({ t: 'allMachines' }, agentId))
        .map((agentId): HappierWhereItsOnMenuItem => ({
          id: `agent:${agentId}`,
          title: names.agentName(agentId),
          testID: `${props.testID}:add:agent:${agentId}`,
          ...(host.hasAgentMark(agentId)
            ? { mark: { kind: 'agent', agentId } }
            : {}),
        }));
      const machineItems = props.places.machines
        .filter(
          (machine) => !has({ t: 'machine', machineId: machine.machineId }),
        )
        .map((machine): HappierWhereItsOnMenuItem => ({
          id: `machine:${machine.machineId}`,
          title: machine.name,
          testID: `${props.testID}:add:machine:${machine.machineId}`,
          mark: { kind: 'icon', name: 'desktop' },
          ...(machine.online
            ? {}
            : {
                trailing: {
                  text:
                    machine.online === false
                      ? words.offline()
                      : words.unknown(),
                },
              }),
        }));
      const projectItems = props.places.projects
        .filter(
          (project) => !has({ t: 'project', projectKey: project.projectKey }),
        )
        .map((project): HappierWhereItsOnMenuItem => ({
          id: `project:${project.projectKey}`,
          title: project.name,
          testID: `${props.testID}:add:project:${project.projectKey}`,
          mark: { kind: 'icon', name: 'folder' },
          trailing: {
            text: words.machineCount(project.machineCount),
            tabular: true,
          },
        }));
      // Under On everywhere the commonest exception is an Agent; under Off, a project (it follows you to every machine).
      const groups = baseOn
        ? [
            { title: words.menuAgent(), items: agentItems },
            { title: words.menuMachine(), items: machineItems },
            { title: words.menuProject(), items: projectItems },
          ]
        : [
            { title: words.menuProjectEverywhere(), items: projectItems },
            { title: words.menuMachine(), items: machineItems },
            { title: words.menuAgentEverywhere(), items: agentItems },
          ];
      return groups.filter((group) => group.items.length > 0);
    }, [rules, props.places, names, baseOn, props.testID, host, words, reach]);

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

    const {
      Rule,
      RemoveButton,
      AgentSelect,
      GroupLabel,
      Text,
      AgentMark,
      PlaceGlyph,
    } = host;
    const ruleRow = (rule: HappierReachRule) => {
      const described = describeHappierReachRule(
        rule,
        names,
        props.kind,
        labels,
      );
      const key = reach.key(rule);
      const testID = `${props.testID}:rule:${key}`;
      // A place turned on can be narrowed to one Agent; the select swaps the qualifier in one change.
      const narrowable = rule.enabled && rule.target.t !== 'allMachines';
      const placeTitle =
        rule.target.t === 'allMachines'
          ? described.title
          : rule.target.t === 'machine'
            ? names.machineName(rule.target.machineId)
            : rule.target.t === 'project'
              ? names.projectName(rule.target.projectKey)
              : names.projectName(rule.target.machineId);
      let agentSelect: React.ReactNode = null;
      if (narrowable && editable) {
        const selected = rule.agentId ?? null;
        const allId = '*';
        agentSelect = (
          <AgentSelect
            testID={`${testID}:agents`}
            label={
              selected === null
                ? words.allAgents()
                : words.agentOnly(names.agentName(selected))
            }
            accessibilityLabel={words.whichAgents(placeTitle)}
            selectedAgentId={
              selected !== null && host.hasAgentMark(selected) ? selected : null
            }
            selectedId={selected ?? allId}
            items={[
              {
                id: allId,
                title: words.allAgents(),
                checked: selected === null,
                testID: `${testID}:agents:all`,
              },
              ...props.places.agentIds.map(
                (agentId): HappierWhereItsOnMenuItem => ({
                  id: agentId,
                  title: names.agentName(agentId),
                  checked: selected === agentId,
                  testID: `${testID}:agents:${agentId}`,
                  ...(host.hasAgentMark(agentId)
                    ? { mark: { kind: 'agent', agentId } }
                    : {}),
                }),
              ),
            ]}
            onSelect={(id) => {
              if (id === (selected ?? allId)) return;
              const agentId = id === allId ? null : id;
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
              );
            }}
          />
        );
      }
      const remove = editable ? (
        <RemoveButton
          testID={`${testID}:remove`}
          accessibilityLabel={words.remove(described.title)}
          onPress={() =>
            write({
              place: rule.target,
              ...(rule.agentId ? { agentId: rule.agentId } : {}),
              state: 'inherit',
            })
          }
        />
      ) : null;
      // A place turned on for all agents never re-enables an excepted Agent there; say so under the row.
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
                    reach.key({ target: other.target }) ===
                      reach.key({ target: rule.target }),
                ),
            )
          : [];
      const mark =
        rule.target.t === 'allMachines' &&
        rule.agentId !== undefined &&
        host.hasAgentMark(rule.agentId) ? (
          <AgentMark agentId={rule.agentId} size="md" />
        ) : (
          <PlaceGlyph
            name={rule.target.t === 'machine' ? 'desktop' : 'folder'}
            size="md"
          />
        );
      return (
        <Rule
          key={key}
          testID={testID}
          title={
            rule.agentId !== undefined && rule.target.t !== 'allMachines'
              ? placeTitle
              : described.title
          }
          subtitle={described.effect}
          mark={mark}
          wideControls={agentSelect !== null}
          {...(agentSelect || remove
            ? {
                controls: (
                  <View style={[RULE_CONTROLS, { gap: space.s8 }]}>
                    {agentSelect}
                    {remove}
                  </View>
                ),
              }
            : {})}
          {...(staysOff.length > 0
            ? {
                note: (
                  <Text
                    variant="meta"
                    tone="tertiary"
                    testID={`${testID}:staysOff`}
                  >
                    {words.staysOff(labels.joinList(happierWhereItsOnAgentNames(staysOff, names)))}
                  </Text>
                ),
              }
            : {})}
        />
      );
    };

    const group = (title: string, rows: readonly HappierReachRule[], key: string) =>
      rows.length === 0 ? null : (
        <View key={key} testID={`${props.testID}:${key}`}>
          <GroupLabel title={title} />
          {rows.map(ruleRow)}
        </View>
      );

    const quietInset = {
      paddingHorizontal: space.s16,
      paddingBottom: space.s8,
    };
    const body = (
      <View testID={`${props.testID}:body`}>
        <SheetHairline />
        <host.Everywhere
          testID={`${props.testID}:everywhere`}
          title={labels.where.everywhere()}
          subtitle={
            baseOn
              ? labels.where.effect.everywhereOn()
              : labels.where.effect.everywhereOff()
          }
          options={[
            { id: 'on', label: words.on() },
            { id: 'off', label: words.off() },
          ]}
          value={baseOn ? 'on' : 'off'}
          disabled={!editable}
          onChange={(next) =>
            write({ place: { t: 'allMachines' }, state: next })
          }
        />
        {/* The rules are their own list: their marks align the rule titles without moving the sentence or Everywhere. */}
        <host.RuleList>
          {baseOn
            ? [
                group(words.except(), offRows, 'except'),
                group(words.turnedOnIn(), onRows, 'turnedOnIn'),
              ]
            : [
                group(words.turnedOnIn(), onRows, 'turnedOnIn'),
                group(words.except(), offRows, 'except'),
              ]}
          {!baseOn && onRows.length === 0 ? (
            <View>
              <GroupLabel title={words.turnedOnIn()} />
              <Text
                variant="body"
                tone="secondary"
                style={quietInset}
                testID={`${props.testID}:nowhere`}
              >
                {words.nowhereYet()}
              </Text>
            </View>
          ) : null}
        </host.RuleList>
        {editable && addGroups.length > 0 ? (
          <View
            style={[
              ADD,
              {
                paddingHorizontal: space.s12,
                paddingTop: space.s4,
                paddingBottom: space.s12,
              },
            ]}
          >
            <host.AddMenu
              testID={`${props.testID}:add`}
              title={baseOn ? words.addException() : words.addPlace()}
              groups={addGroups}
              onSelect={onAdd}
            />
          </View>
        ) : props.readOnlyReason !== undefined ? (
          <Text
            variant="meta"
            tone="tertiary"
            style={quietInset}
            testID={`${props.testID}:readOnly`}
          >
            {props.readOnlyReason}
          </Text>
        ) : null}
        <SheetHairline />
      </View>
    );

    return (
      <host.Section
        testID={props.testID}
        title={words.title()}
        {...(props.presentation === 'section'
          ? { description: words.description() }
          : {})}
      >
        <host.Disclosure
          testID={`${props.testID}:disclosure`}
          rowTestID={`${props.testID}:sentence`}
        showDivider={false}
          expanded={expanded}
          onExpandedChange={setExpanded}
          title={
            <SentenceText
              sentence={sentence}
              names={names}
              host={host}
              testID={`${props.testID}:sentenceText`}
            />
          }
          {...(props.presentation === 'pick'
            ? { changeLabel: words.change() }
            : {})}
        >
          {expanded ? body : null}
        </host.Disclosure>
        <host.ConsequenceRow
          testID={`${props.testID}:consequenceRow`}
          showDivider={failure !== null}
          // Closed, the consequence finishes the sentence's row (one card); open, it follows the rules.
          continuesRow={!expanded}
        >
          <ConsequenceLine
            kind={props.kind}
            projection={props.projection}
            machines={props.places.machines}
            names={names}
            labels={labels}
            host={host}
            agentTakes={props.agentTakes ?? takesEverything}
            anyRuleOn={rules.some((rule) => rule.enabled)}
            gap={space.s4}
            testID={`${props.testID}:consequence`}
          />
        </host.ConsequenceRow>
        {failure ? (
          <host.ErrorLine
            testID={`${props.testID}:error`}
            title={words.changeFailed()}
            diagnostic={failure.message}
            actionLabel={words.tryAgain()}
            onAction={() => void commit(failure.change)}
          />
        ) : null}
      </host.Section>
    );
  },
);

const SENTENCE = { flexShrink: 1 } as const;
const HAIRLINE = { height: StyleSheet.hairlineWidth } as const;
const RULE_CONTROLS = { flexDirection: 'row', alignItems: 'center' } as const;
const ADD = { alignItems: 'flex-start' } as const;
