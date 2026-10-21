import type { ReachPlaceV1 } from '@happier-dev/protocol/reach/reachPlaceV1';
import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { ReachProjectionV1 } from '@happier-dev/protocol/reach/projectReachV1';
import { groupReachRulesV1 } from '@happier-dev/protocol/reach/reachRulesChangeV1';
import { t } from '@/text';
import type {
  CapabilityClauseParams,
  CapabilityPlaceKind,
} from '@/text/translations/capabilityKitTranslations';
import { joinList } from '@/utils/text/joinList';

/**
 * The one owner of "Where it's on" words (P5 K4): the sentence, the row summary, a rule's description and the
 * reach consequence. Structure comes only from P2's `groupReachRulesV1`; no rule precedence is decided here.
 */
export type WhereItsOnNames = Readonly<{
  agentName: (agentId: string) => string;
  machineName: (machineId: string) => string;
  projectName: (projectKey: string) => string;
  /** A 0.2 workspace rule's folder, e.g. "~/client on nl2". */
  folderLabel: (machineId: string, workspaceRoot: string) => string;
}>;

/** One stated rule: the place it names, the Agent it is limited to, and what it says there. */
export type WhereItsOnStatement = Readonly<{
  place: ReachPlaceV1;
  agentId?: string;
  state: 'on' | 'off';
}>;
export type WhereItsOnClause = WhereItsOnStatement & Readonly<{ text: string }>;

export type WhereItsOnSentence = Readonly<{
  /** "On everywhere" | "Only in client-site" | "Off" */
  head: string;
  headKind: 'everywhere' | 'only' | 'off';
  /** What holds where no clause applies. */
  base: 'on' | 'off';
  /** The place an "Only …" head names (it is a statement too). */
  headStatement: WhereItsOnStatement | null;
  /** "except Gemini", "except in client-site", "on for Gemini in happier" */
  clauses: readonly WhereItsOnClause[];
}>;

export type WhereItsOnConsequence = Readonly<{
  /** An empty consequence cannot assert absence before online configured inventory is known. */
  availabilityUnknown: boolean;
  availableAgentIds: readonly string[];
  onlineMachineNames: readonly string[];
  notes: readonly string[];
  onlyProjectNames: readonly string[];
}>;

const SEPARATOR = ' · ';

function describePlace(
  place: ReachPlaceV1,
  names: WhereItsOnNames,
): Readonly<{ place?: string; placeKind?: CapabilityPlaceKind }> {
  switch (place.t) {
    case 'allMachines':
      return {};
    case 'machine':
      return {
        place: names.machineName(place.machineId),
        placeKind: 'machine',
      };
    case 'project':
      return {
        place: names.projectName(place.projectKey),
        placeKind: 'project',
      };
    case 'workspace':
      return {
        place: names.folderLabel(place.machineId, place.workspaceRoot),
        placeKind: 'folder',
      };
  }
}

function clauseParams(
  statement: WhereItsOnStatement,
  names: WhereItsOnNames,
): CapabilityClauseParams {
  return {
    ...(statement.agentId !== undefined
      ? { agent: names.agentName(statement.agentId) }
      : {}),
    ...describePlace(statement.place, names),
  };
}

function toStatement(rule: ReachRuleV1): WhereItsOnStatement {
  return {
    place: rule.target,
    state: rule.enabled ? 'on' : 'off',
    ...(rule.agentId !== undefined ? { agentId: rule.agentId } : {}),
  };
}

const placeRank: Record<ReachPlaceV1['t'], number> = {
  allMachines: 1,
  machine: 2,
  project: 3,
  workspace: 4,
};
/** Broader places first, so a restoring clause reads after the clause it restores from. */
const byBreadth = (left: ReachRuleV1, right: ReachRuleV1) =>
  placeRank[left.target.t] - placeRank[right.target.t];

export function sayWhereItsOn(
  rules: readonly ReachRuleV1[],
  names: WhereItsOnNames,
): WhereItsOnSentence {
  const grouped = groupReachRulesV1(rules);
  const general = [...grouped.turnedOnIn, ...grouped.except]
    .sort(byBreadth)
    .map(toStatement);
  const agents = grouped.agents.flatMap((agent) => [
    ...(agent.everywhere
      ? [
          {
            place: { t: 'allMachines' } as const,
            agentId: agent.agentId,
            state: agent.everywhere,
          },
        ]
      : []),
    ...[...agent.turnedOnIn, ...agent.except].sort(byBreadth).map(toStatement),
  ]);
  // Text order: the head, then each Agent's clauses, then the agent-general clauses.
  const ordered: WhereItsOnStatement[] = [...agents, ...general];
  const base = grouped.base === 'on' ? 'on' : 'off';
  let head: string;
  let headKind: WhereItsOnSentence['headKind'];
  let headStatement: WhereItsOnStatement | null = null;
  if (base === 'on') {
    head = t('capabilities.where.onEverywhere');
    headKind = 'everywhere';
  } else {
    headStatement =
      general.find((statement) => statement.state === 'on') ??
      agents.find((statement) => statement.state === 'on') ??
      null;
    head = headStatement
      ? t('capabilities.where.only', clauseParams(headStatement, names))
      : t('capabilities.where.off');
    headKind = headStatement ? 'only' : 'off';
  }
  const clauses = ordered
    .filter((statement) => statement !== headStatement)
    .map((statement): WhereItsOnClause => ({
      ...statement,
      text:
        statement.state === 'on'
          ? t('capabilities.where.on', clauseParams(statement, names))
          : t('capabilities.where.except', clauseParams(statement, names)),
    }));
  return { head, headKind, base, headStatement, clauses };
}

/** The sentence as one line; past `maxClauses` the rest folds into "· N more". */
export function formatWhereItsOnSentence(
  sentence: WhereItsOnSentence,
  options?: Readonly<{ maxClauses?: number }>,
): string {
  const max = options?.maxClauses ?? Number.POSITIVE_INFINITY;
  const shown = sentence.clauses.slice(0, max).map((clause) => clause.text);
  const hidden = sentence.clauses.length - shown.length;
  return [
    sentence.head,
    ...shown,
    ...(hidden > 0 ? [t('capabilities.where.more', { count: hidden })] : []),
  ].join(SEPARATOR);
}

/** Row summaries and composer scope words; the head never stands alone when the sentence states clauses. */
export function shortWhereItsOn(
  rules: readonly ReachRuleV1[],
  names: WhereItsOnNames,
): string {
  const sentence = sayWhereItsOn(rules, names);
  const head =
    sentence.headKind === 'everywhere'
      ? t('capabilities.where.everywhere')
      : sentence.head;
  if (sentence.clauses.length === 0) return head;
  if (sentence.clauses.length === 1)
    return `${head}${SEPARATOR}${sentence.clauses[0]!.text}`;
  return `${head}${SEPARATOR}${t('capabilities.where.exceptions', { count: sentence.clauses.length })}`;
}

/** One rule's row: its title and its effect in words. */
export function describeReachRule(
  rule: ReachRuleV1,
  names: WhereItsOnNames,
  kind: 'skill' | 'mcp_server',
): Readonly<{ title: string; effect: string }> {
  const { place, placeKind } = describePlace(rule.target, names);
  const agent =
    rule.agentId !== undefined ? names.agentName(rule.agentId) : undefined;
  if (agent !== undefined && place !== undefined && placeKind !== undefined) {
    return {
      title: `${place}${SEPARATOR}${agent}`,
      effect: rule.enabled
        ? t('capabilities.where.effect.agentAtOn', { agent, place, placeKind })
        : t('capabilities.where.effect.agentAtOff', {
            agent,
            place,
            placeKind,
          }),
    };
  }
  if (agent !== undefined) {
    return {
      title: agent,
      effect: rule.enabled
        ? t('capabilities.where.effect.agentEverywhereOn')
        : t('capabilities.where.effect.agentNever', { kind }),
    };
  }
  if (place === undefined) {
    return {
      title: t('capabilities.where.everywhere'),
      effect: rule.enabled
        ? t('capabilities.where.effect.everywhereOn')
        : t('capabilities.where.effect.everywhereOff'),
    };
  }
  const effect =
    placeKind === 'machine'
      ? rule.enabled
        ? t('capabilities.where.effect.machineOn')
        : t('capabilities.where.effect.machineOff')
      : placeKind === 'project'
        ? rule.enabled
          ? t('capabilities.where.effect.projectOn')
          : t('capabilities.where.effect.projectOff')
        : rule.enabled
          ? t('capabilities.where.effect.folderOn')
          : t('capabilities.where.effect.folderOff');
  return { title: place, effect };
}

/** One line for every offline machine that would get an item: its name when one, the count when several. */
export function describeOfflineMachines(machineNames: readonly string[]): string | null {
  if (machineNames.length === 0) return null;
  return machineNames.length === 1
    ? t('capabilities.where.offlineNote', { machine: machineNames[0]! })
    : t('capabilities.where.offlineNoteMany', { count: machineNames.length });
}

/**
 * The live consequence of the rules (IR-80): only Agents that can take the item are named as available; Agents that
 * cannot are named once in `notes`. `online` comes from the caller's reachability owner (C4).
 */
export function describeReach(
  projection: readonly Readonly<ReachProjectionV1[number] & { projectKey?: string; agentInventoryComplete?: boolean }>[],
  machines: readonly Readonly<{ machineId: string; online: boolean }>[],
  names: WhereItsOnNames,
  agentTakes: (agentId: string) => 'full' | 'index' | 'none',
  kind: 'skill' | 'mcp_server' = 'skill',
): WhereItsOnConsequence {
  const online = new Map(
    machines.map((machine) => [machine.machineId, machine.online]),
  );
  const available: string[] = [];
  const onlineMachineNames: string[] = [];
  const offlineMachineNames: string[] = [];
  const cannotTake: string[] = [];
  const projectKeys = new Set<string>();
  let availableOutsideProjects = false;
  for (const row of projection) {
    const enabled = row.agents.filter((agent) => agent.enabled);
    for (const agent of enabled) {
      if (
        agentTakes(agent.agentId) === 'none' &&
        !cannotTake.includes(agent.agentId)
      )
        cannotTake.push(agent.agentId);
    }
    const taking = enabled.filter(
      (agent) => agentTakes(agent.agentId) !== 'none',
    );
    if (taking.length === 0) continue;
    if (online.get(row.machineId) === false) {
      const machineName = names.machineName(row.machineId);
      if (!offlineMachineNames.includes(machineName)) offlineMachineNames.push(machineName);
      continue;
    }
    if (row.projectKey) projectKeys.add(row.projectKey); else availableOutsideProjects = true;
    const machineName = names.machineName(row.machineId);
    if (!onlineMachineNames.includes(machineName)) onlineMachineNames.push(machineName);
    for (const agent of taking)
      if (!available.includes(agent.agentId)) available.push(agent.agentId);
  }
  const offlineNote = describeOfflineMachines(offlineMachineNames);
  return {
    availabilityUnknown: available.length === 0 && projection.some(row =>
      row.agentInventoryComplete === false && online.get(row.machineId) !== false),
    availableAgentIds: available,
    onlineMachineNames,
    onlyProjectNames: availableOutsideProjects ? [] : [...projectKeys].map(names.projectName),
    notes: [
      ...(offlineNote ? [offlineNote] : []),
      ...cannotTake.map((agentId) =>
        t('capabilities.where.cantTake', {
          agent: names.agentName(agentId),
          kind,
        }),
      ),
    ],
  };
}

/**
 * Up to this many machines read by name in the "Available to … on …" sentence; a longer list names the first few
 * and counts the rest. The plain and the marked (control) sentence both fold through `foldMachineNames`.
 */
const NAMED_MACHINES_MAX = 4;
const NAMED_MACHINES_FOLDED = 3;

export function foldMachineNames(machineNames: readonly string[]): readonly string[] {
  if (machineNames.length <= NAMED_MACHINES_MAX) return machineNames;
  return [
    ...machineNames.slice(0, NAMED_MACHINES_FOLDED),
    t('capabilities.detail.moreMachines', { count: machineNames.length - NAMED_MACHINES_FOLDED }),
  ];
}

/** "Available to Claude and Codex on MacBook Pro and nl2", or that it is available nowhere yet. */
export function formatWhereItsOnConsequence(
  consequence: WhereItsOnConsequence,
  names: WhereItsOnNames,
): string {
  if (consequence.availabilityUnknown) return '—';
  if (
    consequence.availableAgentIds.length === 0 ||
    consequence.onlineMachineNames.length === 0
  )
    return t('capabilities.where.availableNowhere');
  return t('capabilities.where.available', {
    agents: joinList(consequence.availableAgentIds.map(names.agentName)),
    machines: joinList(foldMachineNames(consequence.onlineMachineNames)),
    projects: consequence.onlyProjectNames.length ? joinList(consequence.onlyProjectNames) : undefined,
  });
}
