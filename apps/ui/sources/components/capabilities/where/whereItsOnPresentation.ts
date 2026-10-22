import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import {
  applyReachRulesChangeV1,
  groupReachRulesV1,
  normalizeReachRulesV1,
  reachRuleKeyV1,
  reachRulesToDraftsV1,
  resolveCreateReachV1,
} from '@happier-dev/protocol/reach/reachRulesChangeV1';
import {
  describeHappierOfflineMachines,
  describeHappierReach,
  describeHappierReachRule,
  foldHappierMachineNames,
  formatHappierWhereItsOnConsequence,
  formatHappierWhereItsOnSentence,
  sayHappierWhereItsOn,
  shortHappierWhereItsOn,
  type HappierWhereItsOnClause,
  type HappierWhereItsOnConsequence,
  type HappierWhereItsOnControlLabels,
  type HappierWhereItsOnLabels,
  type HappierWhereItsOnNames,
  type HappierWhereItsOnProjectionRow,
  type HappierWhereItsOnReach,
  type HappierWhereItsOnSentence,
  type HappierWhereItsOnStatement,
} from '@happier-dev/plugin-ui/presentation';

import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { joinList } from '@/utils/text/joinList';

/**
 * Happier's words for the shared "Where it's on" owner (`@happier-dev/plugin-ui` presentation): what the sentence,
 * row summary, rule description and reach consequence say, and in which order, is decided there for core pages and
 * plugins alike. Export names stay as the host's importers know them.
 */
export type WhereItsOnNames = HappierWhereItsOnNames;
export type WhereItsOnStatement = HappierWhereItsOnStatement;
export type WhereItsOnClause = HappierWhereItsOnClause;
export type WhereItsOnSentence = HappierWhereItsOnSentence;
export type WhereItsOnConsequence = HappierWhereItsOnConsequence;

const writeContext = () => ({ nowMs: Date.now(), newId: randomUUID });

/** Happier's reach rule engine (protocol `reachRulesChangeV1`), which the shared control writes through. */
export const whereItsOnReach: HappierWhereItsOnReach = {
  group: (rules) => groupReachRulesV1(rules),
  normalize: (rules) => normalizeReachRulesV1(rules),
  key: (rule) => reachRuleKeyV1(rule),
  apply: (rules, change) => applyReachRulesChangeV1(rules, change, writeContext()),
  toDrafts: (rules) => reachRulesToDraftsV1(rules),
  createDefault: (kind) => {
    const created = resolveCreateReachV1({ kind, caller: { surface: 'ui' }, ctx: writeContext() });
    return created.ok ? created.rules : [];
  },
};

export const whereItsOnLabels: HappierWhereItsOnLabels = {
  where: {
    onEverywhere: () => t('capabilities.where.onEverywhere'),
    everywhere: () => t('capabilities.where.everywhere'),
    off: () => t('capabilities.where.off'),
    only: (params) => t('capabilities.where.only', params),
    on: (params) => t('capabilities.where.on', params),
    except: (params) => t('capabilities.where.except', params),
    exceptions: (count) => t('capabilities.where.exceptions', { count }),
    more: (count) => t('capabilities.where.more', { count }),
    effect: {
      everywhereOn: () => t('capabilities.where.effect.everywhereOn'),
      everywhereOff: () => t('capabilities.where.effect.everywhereOff'),
      agentNever: (kind) => t('capabilities.where.effect.agentNever', { kind }),
      agentEverywhereOn: () => t('capabilities.where.effect.agentEverywhereOn'),
      machineOn: () => t('capabilities.where.effect.machineOn'),
      machineOff: () => t('capabilities.where.effect.machineOff'),
      projectOn: () => t('capabilities.where.effect.projectOn'),
      projectOff: () => t('capabilities.where.effect.projectOff'),
      folderOn: () => t('capabilities.where.effect.folderOn'),
      folderOff: () => t('capabilities.where.effect.folderOff'),
      agentAtOn: (params) => t('capabilities.where.effect.agentAtOn', params),
      agentAtOff: (params) => t('capabilities.where.effect.agentAtOff', params),
    },
    available: (params) => t('capabilities.where.available', params),
    availableNowhere: () => t('capabilities.where.availableNowhere'),
    offlineNote: (machine) => t('capabilities.where.offlineNote', { machine }),
    offlineNoteMany: (count) => t('capabilities.where.offlineNoteMany', { count }),
    cantTake: (agent, kind) => t('capabilities.where.cantTake', { agent, kind }),
    moreMachines: (count) => t('capabilities.detail.moreMachines', { count }),
  },
  joinList: (parts) => joinList(parts),
};

export const whereItsOnControlLabels: HappierWhereItsOnControlLabels = {
  ...whereItsOnLabels,
  control: {
    title: () => t('capabilities.control.title'),
    description: () => t('capabilities.control.description'),
    on: () => t('capabilities.control.on'),
    off: () => t('capabilities.control.off'),
    turnedOnIn: () => t('capabilities.control.turnedOnIn'),
    except: () => t('capabilities.control.except'),
    nowhereYet: () => t('capabilities.control.nowhereYet'),
    addException: () => t('capabilities.control.addException'),
    addPlace: () => t('capabilities.control.addPlace'),
    menuAgent: () => t('capabilities.control.menuAgent'),
    menuAgentEverywhere: () => t('capabilities.control.menuAgentEverywhere'),
    menuMachine: () => t('capabilities.control.menuMachine'),
    menuProject: () => t('capabilities.control.menuProject'),
    menuProjectEverywhere: () => t('capabilities.control.menuProjectEverywhere'),
    offline: () => t('capabilities.control.offline'),
    unknown: () => t('common.unknown'),
    machineCount: (count) => t('capabilities.control.machineCount', { count }),
    allAgents: () => t('capabilities.control.allAgents'),
    agentOnly: (agent) => t('capabilities.control.agentOnly', { agent }),
    whichAgents: (place) => t('capabilities.control.whichAgents', { place }),
    remove: (target) => t('capabilities.control.remove', { target }),
    staysOff: (agents) => t('capabilities.control.staysOff', { agents }),
    change: () => t('capabilities.control.change'),
    changeFailed: () => t('capabilities.control.changeFailed'),
    tryAgain: () => t('capabilities.status.fix.tryAgain'),
  },
};

export function sayWhereItsOn(rules: readonly ReachRuleV1[], names: WhereItsOnNames): WhereItsOnSentence {
  return sayHappierWhereItsOn(rules, names, whereItsOnLabels, whereItsOnReach.group);
}

/** The sentence as one line; past `maxClauses` the rest folds into "· N more". */
export function formatWhereItsOnSentence(
  sentence: WhereItsOnSentence,
  options?: Readonly<{ maxClauses?: number }>,
): string {
  return formatHappierWhereItsOnSentence(sentence, whereItsOnLabels, options);
}

/** Row summaries and composer scope words. */
export function shortWhereItsOn(rules: readonly ReachRuleV1[], names: WhereItsOnNames): string {
  return shortHappierWhereItsOn(rules, names, whereItsOnLabels, whereItsOnReach.group);
}

export function describeReachRule(
  rule: ReachRuleV1,
  names: WhereItsOnNames,
  kind: 'skill' | 'mcp_server',
): Readonly<{ title: string; effect: string }> {
  return describeHappierReachRule(rule, names, kind, whereItsOnLabels);
}

export function describeOfflineMachines(machineNames: readonly string[]): string | null {
  return describeHappierOfflineMachines(machineNames, whereItsOnLabels);
}

export function describeReach(
  projection: readonly HappierWhereItsOnProjectionRow[],
  machines: readonly Readonly<{ machineId: string; online: boolean | null }>[],
  names: WhereItsOnNames,
  agentTakes: (agentId: string) => 'full' | 'index' | 'none',
  kind: 'skill' | 'mcp_server' = 'skill',
): WhereItsOnConsequence {
  return describeHappierReach(projection, machines, names, agentTakes, kind, whereItsOnLabels);
}

export function foldMachineNames(machineNames: readonly string[]): readonly string[] {
  return foldHappierMachineNames(machineNames, whereItsOnLabels);
}

export function formatWhereItsOnConsequence(consequence: WhereItsOnConsequence, names: WhereItsOnNames): string {
  return formatHappierWhereItsOnConsequence(consequence, names, whereItsOnLabels);
}
