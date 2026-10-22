import { describe, expect, it } from 'vitest';
import type { ReachRuleV1 } from '@happier-dev/protocol/reach/reachRuleV1';
import type { ReachPlaceV1 } from '@happier-dev/protocol/reach/reachPlaceV1';
import { isReachPlaceApplicableV1, resolveReachV1, type ReachContextV1 } from '@happier-dev/protocol/reach/resolveReachV1';
import { sayWhereItsOn, shortWhereItsOn, type WhereItsOnNames, type WhereItsOnSentence } from './whereItsOnPresentation';

/**
 * D33 (IR-64) and R4-03 (IR-86): the sentence, read literally, states what the resolver decides for every context,
 * and the row summary never hides a clause the sentence states.
 */
const names: WhereItsOnNames = {
    agentName: (id) => `agent-${id}`,
    agentNames: (ids) => ids.map((id) => `agent-${id}`),
    machineName: (id) => `machine-${id}`,
    projectName: (key) => `project-${key}`,
    folderLabel: (machineId, root) => `${root} on machine-${machineId}`,
};

const ROOT = '/work/client';
const places: readonly ReachPlaceV1[] = [
    { t: 'allMachines' },
    { t: 'machine', machineId: 'a' },
    { t: 'machine', machineId: 'b' },
    { t: 'project', projectKey: 'p' },
    { t: 'project', projectKey: 'q' },
    { t: 'workspace', machineId: 'a', workspaceRoot: ROOT },
];
const NAMED_AGENTS = ['g', 'c'] as const;
type Key = Readonly<{ place: ReachPlaceV1; agentId?: string }>;
const keys: readonly Key[] = [undefined, ...NAMED_AGENTS].flatMap((agentId) => places.map((place) => ({ place, ...(agentId ? { agentId } : {}) })));

const contexts: ReachContextV1[] = [];
for (const machineId of ['a', 'b']) for (const projectKey of ['p', 'q', null]) for (const directory of [`${ROOT}/src`, '/elsewhere'])
    for (const agentId of [...NAMED_AGENTS, 'unnamed']) contexts.push({ machineId, machinePlatform: 'posix', projectKey, directory, agentId });

const placeRank: Record<ReachPlaceV1['t'], number> = { allMachines: 1, machine: 2, project: 3, workspace: 4 };

/** The literal reading: clauses naming the Agent first, the narrower place first, then agent-general clauses, then the head. */
function readSentence(sentence: WhereItsOnSentence, context: ReachContextV1): boolean {
    const statements = [...(sentence.headStatement ? [sentence.headStatement] : []), ...sentence.clauses];
    const applicable = statements
        .filter((statement) => statement.place && (statement.agentId === undefined || statement.agentId === context.agentId)
            && isReachPlaceApplicableV1(statement.place, context))
        .sort((left, right) => Number(right.agentId !== undefined) - Number(left.agentId !== undefined)
            || placeRank[right.place!.t] - placeRank[left.place!.t]);
    return applicable.length > 0 ? applicable[0]!.state === 'on' : sentence.base === 'on';
}

function shortHead(summary: string): string {
    return summary.split(' · ')[0]!;
}

function check(rules: ReachRuleV1[]): string | null {
    const sentence = sayWhereItsOn(rules, names);
    for (const context of contexts) {
        const stated = readSentence(sentence, context);
        const resolved = resolveReachV1(rules, context).enabled;
        if (stated !== resolved) return `context ${JSON.stringify(context)} sentence says ${stated}, resolver ${resolved}`;
    }
    const summary = shortWhereItsOn(rules, names);
    const head = shortHead(summary);
    const expectedHead = sentence.headKind === 'everywhere' ? 'Everywhere' : sentence.headKind === 'off' ? 'Off' : sentence.head;
    if (head !== expectedHead) return `summary head "${head}" vs sentence head "${sentence.head}"`;
    const parts = summary.split(' · ');
    const count = parts.length === 1 ? 0 : /^(\d+) exceptions?$/u.exec(parts[1]!) ? Number(/^(\d+)/u.exec(parts[1]!)![1]) : 1;
    if (count !== sentence.clauses.length) return `summary "${summary}" counts ${count}, sentence states ${sentence.clauses.length} clauses`;
    return null;
}

function build(states: readonly (0 | 1 | 2)[], keyList: readonly Key[]): ReachRuleV1[] {
    const rules: ReachRuleV1[] = [];
    states.forEach((state, index) => {
        if (state === 0) return;
        const key = keyList[index]!;
        rules.push({ id: `r${index}`, target: key.place, enabled: state === 1, createdAt: index, updatedAt: index, ...(key.agentId ? { agentId: key.agentId } : {}) });
    });
    return rules;
}

function exhaustive(keyList: readonly Key[]): void {
    const total = 3 ** keyList.length;
    for (let n = 0; n < total; n += 1) {
        const states: (0 | 1 | 2)[] = [];
        let rest = n;
        for (let i = 0; i < keyList.length; i += 1) { states.push((rest % 3) as 0 | 1 | 2); rest = Math.floor(rest / 3); }
        const rules = build(states, keyList);
        const failure = check(rules);
        if (failure) expect.fail(`${failure}\nrules: ${JSON.stringify(rules)}`);
    }
}

describe('where it’s on: sentence ⇔ resolver (D33, R4-03)', () => {
    it('agrees for every agent-general rule set', () => {
        exhaustive(keys.filter((key) => key.agentId === undefined));
    });

    it('agrees for every rule set over Everywhere, a machine, a project and the workspace with one agent qualifier', () => {
        const subset = places.filter((place) => place.t !== 'machine' || place.machineId === 'a').filter((place) => place.t !== 'project' || place.projectKey === 'p');
        exhaustive([...subset.map((place) => ({ place })), ...subset.map((place) => ({ place, agentId: 'g' }))]);
    });

    it('agrees for generated rule sets with two agent qualifiers', () => {
        let seed = 0x2f6b1d;
        const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
        for (let n = 0; n < 6000; n += 1) {
            const density = 0.15 + random() * 0.45;
            const states = keys.map(() => (random() < density ? (random() < 0.5 ? 1 : 2) : 0) as 0 | 1 | 2);
            const rules = build(states, keys);
            const failure = check(rules);
            if (failure) expect.fail(`${failure}\nrules: ${JSON.stringify(rules)}`);
        }
    });
});
