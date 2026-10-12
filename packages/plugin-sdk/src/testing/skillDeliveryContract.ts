import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentContribution } from '../agents.js';
import type { AgentSessionOpenRequest, AgentSessionRuntime, AgentSessionSkillDelivery } from '../agentRuntime/session.js';
import type { ObservedAgentLaunch } from './observeAgentLaunch.js';

export type AgentSkillDeliveryContractInput = Readonly<{
    agent: AgentContribution;
    openSession: (request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>;
    observeLaunch: () => ObservedAgentLaunch;
    invokeSkill?: (runtime: AgentSessionRuntime, name: string) => Promise<void>;
    variants?: readonly Readonly<{
        id: string;
        open: (request: AgentSessionOpenRequest) => Promise<AgentSessionRuntime>;
        expect: 'delivers' | 'restart_required' | 'unsupported';
    }>[];
}>;

function launchStrings(launch: ObservedAgentLaunch): string[] {
    const strings: string[] = [...launch.argv, ...Object.values(launch.env)];
    const collect = (value: unknown): void => {
        if (typeof value === 'string') strings.push(value);
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(launch.acpSessionNew);
    launch.appServerRequests.forEach(request => collect(request.params));
    return strings;
}

function isWithin(path: string, root: string): boolean {
    const child = relative(root, path);
    return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

/** Register the manifest's observable launch contracts; the plugin supplies genuine boundary adapters. */
export function runAgentSkillDeliveryContract(input: AgentSkillDeliveryContractInput): void {
    const capability = input.agent.capabilities.skills;
    describe(`${input.agent.id} skill delivery contract`, () => {
        let directory: string;
        let skills: AgentSessionSkillDelivery;
        const runtimes: AgentSessionRuntime[] = [];
        const request = (delivery?: AgentSessionSkillDelivery): AgentSessionOpenRequest => ({
            kind: 'create', sessionId: 'skill-delivery-contract', cwd: directory,
            ...(delivery ? { skills: delivery } : {}),
        });
        const open = async (factory: AgentSkillDeliveryContractInput['openSession'], delivery?: AgentSessionSkillDelivery) => {
            const runtime = await factory(request(delivery));
            runtimes.push(runtime);
            return runtime;
        };
        const assertDelivery = async () => {
            const strings = launchStrings(input.observeLaunch());
            // Match the longer skills root first: it already includes pluginRoot.
            const roots = [skills.skillsRoot, skills.pluginRoot].sort((a, b) => b.length - a.length);
            const references = strings.flatMap(value => {
                const hits: string[] = [];
                let remaining = value;
                while (remaining.length) {
                    const candidates = roots.map(root => ({ root, index: remaining.indexOf(root) })).filter(hit => hit.index >= 0);
                    candidates.sort((a, b) => a.index - b.index || b.root.length - a.root.length);
                    const hit = candidates[0];
                    if (!hit) break;
                    hits.push(hit.root);
                    remaining = remaining.slice(hit.index + hit.root.length);
                }
                return hits;
            });
            expect(references, 'K1: one session-private skills root reaches the Agent').toHaveLength(1);
            const deliveredRoot = references[0] === skills.pluginRoot ? join(references[0], 'skills') : references[0];
            expect(await readFile(join(deliveredRoot, 'contract-skill', 'SKILL.md'), 'utf8')).toContain('Contract skill');
            expect(await readFile(join(deliveredRoot, 'contract-skill', 'scripts', 'nested.txt'), 'utf8')).toBe('supporting file');
        };
        beforeEach(async () => {
            directory = await mkdtemp(join(tmpdir(), 'happier-skill-delivery-contract-'));
            const pluginRoot = join(directory, 'session');
            const skillsRoot = join(pluginRoot, 'skills');
            await mkdir(join(pluginRoot, '.claude-plugin'), { recursive: true });
            await writeFile(join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'happier' }));
            await mkdir(join(skillsRoot, 'contract-skill', 'scripts'), { recursive: true });
            await writeFile(join(skillsRoot, 'contract-skill', 'SKILL.md'), '---\nname: contract-skill\ndescription: Contract skill\n---\nRead scripts/nested.txt.\n');
            await writeFile(join(skillsRoot, 'contract-skill', 'scripts', 'nested.txt'), 'supporting file');
            skills = { pluginRoot, skillsRoot, items: [{ name: 'contract-skill', skillId: 'contract:skill', digest: 'sha256:contract' }],
                nativeDisables: [{ name: 'contract-native-blocked', path: join(directory, 'native', 'contract-native-blocked', 'SKILL.md') }] };
        });
        afterEach(async () => {
            try { for (const runtime of runtimes.splice(0).reverse()) await runtime.dispose(); }
            finally { if (directory) await rm(directory, { recursive: true, force: true }); }
        });
        it('K1 delivers the complete bundle exactly once when declared', async () => {
            const runtime = await open(input.openSession, skills);
            if (capability?.delivery === 'session_dir') {
                expect(runtime.skillsDelivered).not.toBe(false);
                await assertDelivery();
            } else {
                expect(launchStrings(input.observeLaunch()).join('\n')).not.toContain(skills.pluginRoot);
            }
        });
        it('K1 leaves launches without skills unchanged after a skills launch', async () => {
            const baseline = await open(input.openSession);
            const before = input.observeLaunch();
            await baseline.dispose();
            runtimes.splice(runtimes.indexOf(baseline), 1);
            const delivered = await open(input.openSession, skills);
            await delivered.dispose();
            runtimes.splice(runtimes.indexOf(delivered), 1);
            await open(input.openSession);
            const after = input.observeLaunch();
            expect({ argv: after.argv, env: after.env, acpSessionNew: after.acpSessionNew, appServerRequests: after.appServerRequests })
                .toEqual({ argv: before.argv, env: before.env, acpSessionNew: before.acpSessionNew, appServerRequests: before.appServerRequests });
        });
        it('K3 applies native disables iff the declaration supports them', async () => {
            await open(input.openSession, skills);
            const observed = launchStrings(input.observeLaunch()).join('\n');
            const disabled = observed.includes('contract-native-blocked');
            expect(disabled).toBe(capability?.nativeDisable === 'supported');
        });
        it('K5 preserves the fixture native home byte-for-byte', async () => {
            await open(input.openSession, skills);
            const launch = input.observeLaunch();
            const privateRoots = [skills.pluginRoot, ...Object.entries(launch.env)
                .filter(([key]) => key.endsWith('_CONFIG_DIR') || key === 'XDG_CONFIG_HOME' || key === 'GEMINI_CLI_HOME')
                .map(([, value]) => value)];
            expect(launch.filesWritten.filter(path => !privateRoots.some(root => isWithin(path, root))),
                'K5: launch must not write the native fixture home').toEqual([]);
        });
        it('K6 implements and acknowledges declared live reload', async () => {
            const runtime = await open(input.openSession, skills);
            if (capability?.liveReload !== 'supported') return;
            expect(runtime.refreshSkills).toBeTypeOf('function');
            expect(await runtime.refreshSkills!({ skills })).toEqual({ kind: 'applied' });
        });
        for (const variant of input.variants ?? []) {
            it(`K10 reports ${variant.id} truthfully`, async () => {
                const runtime = await open(variant.open, skills);
                if (variant.expect === 'unsupported') {
                    expect(runtime.skillsDelivered).toBe(false);
                    expect(launchStrings(input.observeLaunch()).join('\n')).not.toContain(skills.pluginRoot);
                    return;
                }
                expect(runtime.skillsDelivered).not.toBe(false);
                await assertDelivery();
                if (variant.expect === 'restart_required') {
                    expect(runtime.refreshSkills).toBeTypeOf('function');
                    expect(await runtime.refreshSkills!({ skills })).toEqual({ kind: 'restart_required', reason: 'launch_path_unsupported' });
                }
            });
        }
        if (capability?.usageEvidence === 'reported') {
            it('K13 emits native invocation evidence when declared', async () => {
                expect(input.invokeSkill).toBeTypeOf('function');
                const runtime = await open(input.openSession, skills);
                await input.invokeSkill!(runtime, 'contract-skill');
                expect(input.observeLaunch().runtimeEvents.some(event => {
                    if (!event || typeof event !== 'object' || !('kind' in event) || event.kind !== 'skill-usage' || !('skills' in event) || !Array.isArray(event.skills)) return false;
                    return event.skills.some(skill => skill && typeof skill === 'object' && 'name' in skill
                        && (skill.name === 'contract-skill' || skill.name === 'happier:contract-skill'));
                })).toBe(true);
            });
        }
    });
}
