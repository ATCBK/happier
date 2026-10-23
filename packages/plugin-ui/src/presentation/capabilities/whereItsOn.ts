/**
 * The reach model the words read, structurally (the rule engine itself — grouping, precedence, writes — stays with
 * its owner: Happier's reach rules, or a plugin's own state; this module never decides precedence).
 */
export type HappierReachPlace =
  | Readonly<{ t: 'allMachines' }>
  | Readonly<{ t: 'machine'; machineId: string }>
  | Readonly<{ t: 'project'; projectKey: string }>
  | Readonly<{ t: 'workspace'; machineId: string; workspaceRoot: string }>;
export type HappierReachRule = Readonly<{
  id: string;
  target: HappierReachPlace;
  agentId?: string | undefined;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}>;
export type HappierReachWrite = Readonly<{
  place: HappierReachPlace;
  agentId?: string | undefined;
  state: 'on' | 'off' | 'inherit';
}>;
export type HappierReachGrouped = Readonly<{
  base: 'on' | 'off' | 'none';
  turnedOnIn: readonly HappierReachRule[];
  except: readonly HappierReachRule[];
  agents: readonly Readonly<{
    agentId: string;
    everywhere: 'on' | 'off' | null;
    turnedOnIn: readonly HappierReachRule[];
    except: readonly HappierReachRule[];
  }>[];
}>;
/** The caller's reach rule engine: how rules group into a sentence. */
export type HappierWhereItsOnGroup = (rules: readonly HappierReachRule[]) => HappierReachGrouped;

/**
 * The one owner of "Where it's on" words (Capabilities P5 K4), shared by Happier's skills and MCP pages and by
 * plugins that manage installable things: the sentence, the row summary, a rule's description and the reach
 * consequence. Structure comes only from the caller's reach engine (`group`); no rule precedence is decided here.
 * The caller supplies the words (its own translations) and the names; this module decides what is said, in which
 * order, and what folds.
 */
export type HappierWhereItsOnNames = Readonly<{
  agentName: (agentId: string) => string;
  /**
   * The names a list of Agents reads as, each once ("Claude, QA Alpha and QA Beta"): one runtime id can stand for
   * several titled instances, so a sentence composes the names once instead of nesting lists.
   */
  agentNames: (agentIds: readonly string[]) => readonly string[];
  machineName: (machineId: string) => string;
  projectName: (projectKey: string) => string;
  /** A 0.2 workspace rule's folder, e.g. "~/client on nl2". */
  folderLabel: (machineId: string, workspaceRoot: string) => string;
}>;

export type HappierWhereItsOnPlaceKind = 'machine' | 'project' | 'folder';
/** One clause's subject: an Agent, a place, or both ("for Gemini in happier"). */
export type HappierWhereItsOnClauseParams = Readonly<{
  agent?: string;
  place?: string;
  placeKind?: HappierWhereItsOnPlaceKind;
}>;
export type HappierWhereItsOnItemKind = 'skill' | 'mcp_server';
type AgentAt = Readonly<{
  agent: string;
  place: string;
  placeKind: HappierWhereItsOnPlaceKind;
}>;

/** The caller's words for "Where it's on" (Happier passes its locale table; a plugin its own bundle). */
export type HappierWhereItsOnLabels = Readonly<{
  where: Readonly<{
    onEverywhere: () => string;
    everywhere: () => string;
    off: () => string;
    only: (params: HappierWhereItsOnClauseParams) => string;
    on: (params: HappierWhereItsOnClauseParams) => string;
    except: (params: HappierWhereItsOnClauseParams) => string;
    exceptions: (count: number) => string;
    more: (count: number) => string;
    effect: Readonly<{
      everywhereOn: () => string;
      everywhereOff: () => string;
      agentNever: (kind: HappierWhereItsOnItemKind) => string;
      agentEverywhereOn: () => string;
      machineOn: () => string;
      machineOff: () => string;
      projectOn: () => string;
      projectOff: () => string;
      folderOn: () => string;
      folderOff: () => string;
      agentAtOn: (params: AgentAt) => string;
      agentAtOff: (params: AgentAt) => string;
    }>;
    available: (
      params: Readonly<{ agents: string; machines: string; projects?: string }>,
    ) => string;
    availableNowhere: () => string;
    offlineNote: (machine: string) => string;
    offlineNoteMany: (count: number) => string;
    cantTake: (agent: string, kind: HappierWhereItsOnItemKind) => string;
    /** "2 more machines" when a long machine list folds. */
    moreMachines: (count: number) => string;
  }>;
  /** "a, b and c" in the reader's language. */
  joinList: (parts: readonly string[]) => string;
}>;

/** One stated rule: the place it names, the Agent it is limited to, and what it says there. */
export type HappierWhereItsOnStatement = Readonly<{
  place: HappierReachPlace;
  agentId?: string;
  state: 'on' | 'off';
}>;
export type HappierWhereItsOnClause = HappierWhereItsOnStatement &
  Readonly<{ text: string }>;

export type HappierWhereItsOnSentence = Readonly<{
  /** "On everywhere" | "Only in client-site" | "Off" */
  head: string;
  headKind: 'everywhere' | 'only' | 'off';
  /** What holds where no clause applies. */
  base: 'on' | 'off';
  /** The place an "Only …" head names (it is a statement too). */
  headStatement: HappierWhereItsOnStatement | null;
  /** "except Gemini", "except in client-site", "on for Gemini in happier" */
  clauses: readonly HappierWhereItsOnClause[];
}>;

export type HappierWhereItsOnConsequence = Readonly<{
  /** An empty consequence cannot assert absence before online configured inventory is known. */
  availabilityUnknown: boolean;
  availableAgentIds: readonly string[];
  onlineMachineNames: readonly string[];
  notes: readonly string[];
  onlyProjectNames: readonly string[];
}>;

/** A reach projection row as the consequence reads it (the caller may join a project and inventory completeness). */
export type HappierWhereItsOnProjectionRow = Readonly<{
  machineId: string;
  agents: readonly Readonly<{ agentId: string; enabled: boolean }>[];
  projectKey?: string;
  agentInventoryComplete?: boolean;
}>;

const SEPARATOR = ' · ';

function describePlace(
  place: HappierReachPlace,
  names: HappierWhereItsOnNames,
): Readonly<{ place?: string; placeKind?: HappierWhereItsOnPlaceKind }> {
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
  statement: HappierWhereItsOnStatement,
  names: HappierWhereItsOnNames,
): HappierWhereItsOnClauseParams {
  return {
    ...(statement.agentId !== undefined
      ? { agent: names.agentName(statement.agentId) }
      : {}),
    ...describePlace(statement.place, names),
  };
}

function toStatement(rule: HappierReachRule): HappierWhereItsOnStatement {
  return {
    place: rule.target,
    state: rule.enabled ? 'on' : 'off',
    ...(rule.agentId !== undefined ? { agentId: rule.agentId } : {}),
  };
}

const placeRank: Record<HappierReachPlace['t'], number> = {
  allMachines: 1,
  machine: 2,
  project: 3,
  workspace: 4,
};
/** Broader places first, so a restoring clause reads after the clause it restores from. */
const byBreadth = (left: HappierReachRule, right: HappierReachRule) =>
  placeRank[left.target.t] - placeRank[right.target.t];

export function sayHappierWhereItsOn(
  rules: readonly HappierReachRule[],
  names: HappierWhereItsOnNames,
  labels: HappierWhereItsOnLabels,
  group: HappierWhereItsOnGroup,
): HappierWhereItsOnSentence {
  const words = labels.where;
  const grouped = group(rules);
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
  const ordered: HappierWhereItsOnStatement[] = [...agents, ...general];
  const base = grouped.base === 'on' ? 'on' : 'off';
  let head: string;
  let headKind: HappierWhereItsOnSentence['headKind'];
  let headStatement: HappierWhereItsOnStatement | null = null;
  if (base === 'on') {
    head = words.onEverywhere();
    headKind = 'everywhere';
  } else {
    headStatement =
      general.find((statement) => statement.state === 'on') ??
      agents.find((statement) => statement.state === 'on') ??
      null;
    head = headStatement
      ? words.only(clauseParams(headStatement, names))
      : words.off();
    headKind = headStatement ? 'only' : 'off';
  }
  const clauses = ordered
    .filter((statement) => statement !== headStatement)
    .map((statement): HappierWhereItsOnClause => ({
      ...statement,
      text:
        statement.state === 'on'
          ? words.on(clauseParams(statement, names))
          : words.except(clauseParams(statement, names)),
    }));
  return { head, headKind, base, headStatement, clauses };
}

/** The sentence as one line; past `maxClauses` the rest folds into "· N more". */
export function formatHappierWhereItsOnSentence(
  sentence: HappierWhereItsOnSentence,
  labels: HappierWhereItsOnLabels,
  options?: Readonly<{ maxClauses?: number }>,
): string {
  const max = options?.maxClauses ?? Number.POSITIVE_INFINITY;
  const shown = sentence.clauses.slice(0, max).map((clause) => clause.text);
  const hidden = sentence.clauses.length - shown.length;
  return [
    sentence.head,
    ...shown,
    ...(hidden > 0 ? [labels.where.more(hidden)] : []),
  ].join(SEPARATOR);
}

/** Row summaries and composer scope words; the head never stands alone when the sentence states clauses. */
export function shortHappierWhereItsOn(
  rules: readonly HappierReachRule[],
  names: HappierWhereItsOnNames,
  labels: HappierWhereItsOnLabels,
  group: HappierWhereItsOnGroup,
): string {
  const sentence = sayHappierWhereItsOn(rules, names, labels, group);
  const head =
    sentence.headKind === 'everywhere'
      ? labels.where.everywhere()
      : sentence.head;
  if (sentence.clauses.length === 0) return head;
  if (sentence.clauses.length === 1)
    return `${head}${SEPARATOR}${sentence.clauses[0]!.text}`;
  return `${head}${SEPARATOR}${labels.where.exceptions(sentence.clauses.length)}`;
}

/** One rule's row: its title and its effect in words. */
export function describeHappierReachRule(
  rule: Pick<HappierReachRule, 'target' | 'agentId' | 'enabled'>,
  names: HappierWhereItsOnNames,
  kind: HappierWhereItsOnItemKind,
  labels: HappierWhereItsOnLabels,
): Readonly<{ title: string; effect: string }> {
  const effect = labels.where.effect;
  const { place, placeKind } = describePlace(rule.target, names);
  const agent =
    rule.agentId !== undefined ? names.agentName(rule.agentId) : undefined;
  if (agent !== undefined && place !== undefined && placeKind !== undefined) {
    return {
      title: `${place}${SEPARATOR}${agent}`,
      effect: rule.enabled
        ? effect.agentAtOn({ agent, place, placeKind })
        : effect.agentAtOff({ agent, place, placeKind }),
    };
  }
  if (agent !== undefined) {
    return {
      title: agent,
      effect: rule.enabled
        ? effect.agentEverywhereOn()
        : effect.agentNever(kind),
    };
  }
  if (place === undefined) {
    return {
      title: labels.where.everywhere(),
      effect: rule.enabled ? effect.everywhereOn() : effect.everywhereOff(),
    };
  }
  const text =
    placeKind === 'machine'
      ? rule.enabled
        ? effect.machineOn()
        : effect.machineOff()
      : placeKind === 'project'
        ? rule.enabled
          ? effect.projectOn()
          : effect.projectOff()
        : rule.enabled
          ? effect.folderOn()
          : effect.folderOff();
  return { title: place, effect: text };
}

/** One line for every offline machine that would get an item: its name when one, the count when several. */
export function describeHappierOfflineMachines(
  machineNames: readonly string[],
  labels: HappierWhereItsOnLabels,
): string | null {
  if (machineNames.length === 0) return null;
  return machineNames.length === 1
    ? labels.where.offlineNote(machineNames[0]!)
    : labels.where.offlineNoteMany(machineNames.length);
}

/**
 * The live consequence of the rules (IR-80): only Agents that can take the item are named as available; Agents that
 * cannot are named once in `notes`. `online` comes from the caller's reachability owner.
 */
export function describeHappierReach(
  projection: readonly HappierWhereItsOnProjectionRow[],
  machines: readonly Readonly<{ machineId: string; online: boolean | null }>[],
  names: HappierWhereItsOnNames,
  agentTakes: (agentId: string) => 'full' | 'index' | 'none',
  kind: HappierWhereItsOnItemKind,
  labels: HappierWhereItsOnLabels,
): HappierWhereItsOnConsequence {
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
      if (!offlineMachineNames.includes(machineName))
        offlineMachineNames.push(machineName);
      continue;
    }
    if (online.get(row.machineId) !== true) continue;
    if (row.projectKey) projectKeys.add(row.projectKey);
    else availableOutsideProjects = true;
    const machineName = names.machineName(row.machineId);
    if (!onlineMachineNames.includes(machineName))
      onlineMachineNames.push(machineName);
    for (const agent of taking)
      if (!available.includes(agent.agentId)) available.push(agent.agentId);
  }
  const offlineNote = describeHappierOfflineMachines(
    offlineMachineNames,
    labels,
  );
  return {
    availabilityUnknown:
      available.length === 0 &&
      projection.some(
        (row) =>
          online.get(row.machineId) == null ||
          (row.agentInventoryComplete === false &&
            online.get(row.machineId) === true),
      ),
    availableAgentIds: available,
    onlineMachineNames,
    onlyProjectNames: availableOutsideProjects
      ? []
      : [...projectKeys].map(names.projectName),
    notes: [
      ...(offlineNote ? [offlineNote] : []),
      ...cannotTake.map((agentId) =>
        labels.where.cantTake(names.agentName(agentId), kind),
      ),
    ],
  };
}

/**
 * Up to this many machines read by name in the "Available to … on …" sentence; a longer list names the first few
 * and counts the rest. The plain and the marked (control) sentence both fold through `foldHappierMachineNames`.
 */
const NAMED_MACHINES_MAX = 4;
const NAMED_MACHINES_FOLDED = 3;

export function foldHappierMachineNames(
  machineNames: readonly string[],
  labels: HappierWhereItsOnLabels,
): readonly string[] {
  if (machineNames.length <= NAMED_MACHINES_MAX) return machineNames;
  return [
    ...machineNames.slice(0, NAMED_MACHINES_FOLDED),
    labels.where.moreMachines(machineNames.length - NAMED_MACHINES_FOLDED),
  ];
}

/** The Agent names an "Available to …" list reads, each once. */
export function happierWhereItsOnAgentNames(
  agentIds: readonly string[],
  names: HappierWhereItsOnNames,
): readonly string[] {
  return names.agentNames(agentIds);
}

/** "Available to Claude and Codex on MacBook Pro and nl2", or that it is available nowhere yet. */
export function formatHappierWhereItsOnConsequence(
  consequence: HappierWhereItsOnConsequence,
  names: HappierWhereItsOnNames,
  labels: HappierWhereItsOnLabels,
): string {
  if (consequence.availabilityUnknown) return '—';
  if (
    consequence.availableAgentIds.length === 0 ||
    consequence.onlineMachineNames.length === 0
  )
    return labels.where.availableNowhere();
  return labels.where.available({
    agents: labels.joinList(
      happierWhereItsOnAgentNames(consequence.availableAgentIds, names),
    ),
    machines: labels.joinList(
      foldHappierMachineNames(consequence.onlineMachineNames, labels),
    ),
    ...(consequence.onlyProjectNames.length
      ? { projects: labels.joinList(consequence.onlyProjectNames) }
      : {}),
  });
}
