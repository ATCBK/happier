import {
    getAgentCliSetupRecommendedIds,
} from '@happier-dev/agents';
import {
    installAgentCliForRuntime,
    planAgentCliInstallForRuntime,
    classifyAgentCliInstall,
    resolvePlatformFromNodePlatform,
    resolveAgentCliCommandForRuntime,
    type InstallAgentCliResult,
    type AgentCliCommandResolution,
    type AgentCliRuntimeDescriptor,
} from '@happier-dev/cli-common/agents';

import type { CommandContext } from '@/cli/commandRegistry';
import { wantsJson, printJsonEnvelope } from '@/cli/output/jsonEnvelope';
import { configuration } from '@/configuration';
import { resolveMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type { ResolvedContributionRegistry, ResolvedAgentContribution } from '@/plugins/projection/registry/types';
import { isInteractiveTerminal } from '@/terminal/prompts/promptInput';
import { promptMultipleSelection } from '@/terminal/prompts/promptMultipleChoice';
import { promptConfirmYesNo } from '@/terminal/prompts/promptConfirmYesNo';
import { waitForLocalAgentInstallJob } from './agents/installJobClient';
import { bullets, cmd, createOutputBuilder, dim, errorFrame, fail, kv, neutral, ok, renderHelpPage, sectionTitle } from '@happier-dev/cli-common/output';
import type { CapabilityId } from '@happier-dev/protocol';
import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { resolveConnectTargetServiceIdsFromRegistry } from './connect/resolveConnectTargetServiceIds';

function usage(agentRows: readonly AgentStatusRow[] = []): string {
    const agentRowsSection = agentRows.length > 0
      ? [{
          title: 'Available agents:',
          rows: agentRows.map((row) => ({
            label: cmd(`${row.title} (${row.id})`),
            description: row.runtimeSpec
                ? `Install with ${cmd(`happier agents install ${row.id}`)}`
                : 'Provided by an installed plugin runtime',
          })),
        }]
      : [];

    return renderHelpPage({
        title: 'happier agents',
        subtitle: 'Agent CLI helpers',
        usage: [
            { label: 'happier agents list [--json]', description: 'List agents and whether they are installed' },
            { label: 'happier agents status [--json]', description: 'Show agent status for the current environment' },
            { label: 'happier agents probe <agentId> [--models] [--modes] [--config-options] [--json]', description: 'Probe agent model, mode, and config-option availability' },
            { label: 'happier agents auth login <agentId>', description: 'Authenticate an agent-owned managed ACP runtime' },
            { label: 'happier agents install <agentId> [--dry-run] [--force]', description: 'Install one agent CLI' },
            { label: 'happier agents update <agentId> [--dry-run] [--yes]', description: 'Update an installed agent CLI through its owner' },
            { label: 'happier agents setup [--provider <id> ...] [--providers <id1,id2>] [--dry-run] [--force] [--yes]', description: 'Install one or more agents' },
        ],
        sections: agentRowsSection,
        notes: [
            'Agents are the local tools Happier can run sessions with.',
            'Installs are binary-safe and do not require Node or a package manager.',
            'Install/update jobs run in the local daemon. Vendor recipes require --yes, --allow-vendor-recipe, or interactive confirmation.',
            `For cloud-stored API keys and subscription OAuth, use ${cmd('happier connect')}.`,
            `Non-interactive defaults: ${cmd('happier agents setup --yes')} installs the recommended agents.`,
        ],
    });
}

function readRepeatedFlagValues(argv: readonly string[], flag: string): string[] {
    const values: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
        if (argv[index] !== flag) continue;
        const value = argv[index + 1];
        if (typeof value === 'string' && value.trim()) {
            values.push(value.trim());
            index += 1;
        }
    }
    return values;
}

function readSingleFlagValue(argv: readonly string[], flag: string): string | null {
    const index = argv.indexOf(flag);
    if (index < 0) return null;
    const value = argv[index + 1];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function parseInstallFlags(args: readonly string[]): Readonly<{ dryRun: boolean; skipIfInstalled: boolean; vendorConsent: boolean }> {
    return {
        dryRun: args.includes('--dry-run'),
        skipIfInstalled: !args.includes('--force'),
        vendorConsent: args.includes('--yes') || args.includes('--allow-vendor-recipe'),
    };
}

class UnsupportedAgentsSetupSelectionError extends Error {
    readonly code = 'unsupported_agent';
    readonly agentIds: readonly string[];

    constructor(agentIds: readonly string[]) {
        super(`Unsupported agent id(s) for setup: ${agentIds.join(', ')}`);
        this.name = 'UnsupportedAgentsSetupSelectionError';
        this.agentIds = agentIds;
    }
}

type AgentProbeMethod = 'probeModels' | 'probeModes' | 'probeConfigOptions';

function parseAgentProbeMethods(args: readonly string[]): AgentProbeMethod[] {
    const includeModels = args.includes('--models');
    const includeModes = args.includes('--modes');
    const includeConfigOptions = args.includes('--config-options') || args.includes('--config');
    if (!includeModels && !includeModes && !includeConfigOptions) {
        return ['probeModels', 'probeModes', 'probeConfigOptions'];
    }
    return [
        ...(includeModels ? ['probeModels' as const] : []),
        ...(includeModes ? ['probeModes' as const] : []),
        ...(includeConfigOptions ? ['probeConfigOptions' as const] : []),
    ];
}

function parsePositiveIntFlag(args: readonly string[], flag: string): number | null {
    const raw = readSingleFlagValue(args, flag);
    if (!raw) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
}

function agentProbeResultKey(method: AgentProbeMethod): 'models' | 'modes' | 'configOptions' {
    if (method === 'probeModels') return 'models';
    if (method === 'probeModes') return 'modes';
    return 'configOptions';
}

async function printUnknownAgentJsonEnvelope(kind: string, agentId: string): Promise<void> {
    await printJsonEnvelope({
        ok: false,
        kind,
        error: {
            code: 'unknown_agent',
            message: `Unknown agent id: ${agentId}`,
            agentId,
        },
    }, { exitCode: 1 });
}

type AgentStatusRow = Readonly<{
    id: string;
    title: string;
    runtimeSpec: AgentCliRuntimeDescriptor | null;
    installed: boolean;
    resolution: AgentCliCommandResolution | null;
}>;

type InstallableAgentStatusRow = AgentStatusRow & Readonly<{
    runtimeSpec: AgentCliRuntimeDescriptor;
}>;

function readAgentCliRuntimeDescriptor(contribution: ResolvedAgentContribution): AgentCliRuntimeDescriptor | null {
    return contribution.runtimeSpec ?? null;
}

function readAgentTitle(contribution: ResolvedAgentContribution): string {
    const runtimeTitle = contribution.runtimeSpec?.title;
    if (runtimeTitle) return runtimeTitle;
    const definition = contribution.richDefinition?.definition as Readonly<{ title?: unknown }> | undefined;
    const title = definition?.title;
    if (typeof title === 'string' && title.trim()) return title.trim();
    if (title && typeof title === 'object' && 'fallback' in title) {
        const fallback = (title as Readonly<{ fallback?: unknown }>).fallback;
        if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
    }
    return contribution.id;
}

function listAgentStatus(
    registry: Pick<ResolvedContributionRegistry, 'agents'>,
    processEnv: NodeJS.ProcessEnv,
): AgentStatusRow[] {
    return registry.agents
        .filter((contribution) => !contribution.identity || listAgentExecutionTargetsV1(contribution.identity).length > 0)
        .map((contribution) => {
            const runtimeSpec = readAgentCliRuntimeDescriptor(contribution);
            const resolution = runtimeSpec
                ? resolveAgentCliCommandForRuntime(runtimeSpec, { processEnv })
                : null;
            return {
                id: contribution.id,
                title: readAgentTitle(contribution),
                runtimeSpec,
                installed: resolution !== null,
                resolution,
            } satisfies AgentStatusRow;
        })
        .sort((a, b) => a.id.localeCompare(b.id));
}

function printHumanStatus(rows: readonly AgentStatusRow[]): void {
    const out = createOutputBuilder();
    if (rows.length === 0) {
        out.line(neutral('(no agents available)'));
        console.log(out.render());
        return;
    }

    for (const row of rows) {
        const source = row.resolution?.source ? ` ${dim(`(${row.resolution.source})`)}` : '';
        out.line((row.installed ? ok : neutral)(`${row.title} ${dim(row.id)}${source}`));
        if (row.resolution?.command) {
            out.line(`  ${kv('Command:', row.resolution.command)}`);
        }
    }
    console.log(out.render());
}

type AgentsInstallResult = Readonly<{
    plan: Extract<InstallAgentCliResult, { ok: true }>['plan'] | null;
    logPath: string | null;
    jobId?: string;
    version?: string | null;
}> & (Readonly<{ ok: true; alreadyInstalled: boolean }> | Readonly<{
    ok: false; errorCode: string; errorMessage: string; stepId?: string; guideUrl?: string;
}>);

export function formatAgentInstallJobCompletion(input: Readonly<{
    title: string;
    version: string | null;
}>): string {
    // Start may adopt any running job for this agent, regardless of argv intent.
    // The terminal outcome/version is observed; the requested mutation is not.
    return `${input.title} job completed successfully${input.version ? ` (${input.version})` : ''}.`;
}

async function runAgentsInstall(
    runtimeSpec: AgentCliRuntimeDescriptor,
    flags: ReturnType<typeof parseInstallFlags>,
    intent: 'install' | 'update' = 'install',
    json = false,
): Promise<AgentsInstallResult> {
    const platform = resolvePlatformFromNodePlatform(process.platform);
    const planned = platform ? planAgentCliInstallForRuntime({ runtimeSpec, platform }) : null;
    const plan = planned?.ok ? planned.plan : null;
    const resolution = resolveAgentCliCommandForRuntime(runtimeSpec, { processEnv: process.env });
    if (flags.dryRun) {
        if (!platform) return { ok: false, errorCode: 'unsupported_platform', errorMessage: `Unsupported platform: ${process.platform}`, plan, logPath: null };
        if (intent === 'update' && !resolution) {
            return { ok: false, errorCode: 'update_not_available', errorMessage: 'The agent CLI must be installed before it can be updated.', plan, logPath: null };
        }
        return await installAgentCliForRuntime({
            runtimeSpec, platform, env: process.env, dryRun: true,
            skipIfInstalled: flags.skipIfInstalled, allowVendorRecipeExecution: false,
            intent,
            ...(intent === 'update' && resolution ? { updateTarget: { command: resolution.command, source: resolution.source } } : {}),
        });
    }
    const vendorRecipe = intent === 'update' && resolution && platform
        ? classifyAgentCliInstall({ runtimeSpec, platform, command: resolution.command, source: resolution.source, env: process.env }).nativeUpdateArgs !== null
        : plan?.installMode === 'vendor_recipe';
    const vendorConsent = flags.vendorConsent || Boolean(vendorRecipe && !json && isInteractiveTerminal()
        && await promptConfirmYesNo(`Allow ${runtimeSpec.title}'s vendor installation/update recipe to run on this machine?`, { default: 'no' }));
    const result = await waitForLocalAgentInstallJob({
        request: { agentId: runtimeSpec.id, intent, consent: { vendorRecipe: vendorConsent }, ...(!flags.skipIfInstalled ? { force: true } : {}) },
        ...(!json ? { onEvent: (event) => {
            if (event.t === 'step') process.stderr.write(`${event.label}: ${event.state}\n`);
            else if (event.t === 'log') process.stderr.write(`${event.line}\n`);
            else process.stderr.write(`${event.stepId}: ${event.bytesDone}${event.bytesTotal === null ? '' : `/${event.bytesTotal}`} bytes\n`);
        } } : {}),
    });
    if (!result.ok) return { ok: false, errorCode: result.errorCode, errorMessage: result.error, plan, logPath: null };
    if (result.outcome.kind === 'failed') {
        return { ok: false, errorCode: result.outcome.code, errorMessage: result.outcome.message, stepId: result.outcome.stepId,
            ...(result.outcome.guideUrl ? { guideUrl: result.outcome.guideUrl } : {}), jobId: result.jobId, plan, logPath: null };
    }
    return { ok: true, alreadyInstalled: intent === 'install' && flags.skipIfInstalled && resolution !== null,
        jobId: result.jobId, version: result.outcome.version, plan, logPath: null };
}

function isSetupSupportedAgentRow(row: AgentStatusRow): row is InstallableAgentStatusRow {
    return row.runtimeSpec !== null && row.runtimeSpec.manualInstallKind !== 'none';
}

async function resolveAgentsSetupSelection(args: readonly string[], rows: readonly AgentStatusRow[]): Promise<string[]> {
    const supportedRows = rows.filter(isSetupSupportedAgentRow);
    const supportedById = new Map(supportedRows.map((row) => [row.id, row] as const));
    const explicit = readRepeatedFlagValues(args, '--provider');
    const csv = (() => {
        const raw = readSingleFlagValue(args, '--providers');
        if (!raw) return [];
        return raw
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
    })();
    const combined = Array.from(new Set([...explicit, ...csv]));
    if (combined.length > 0) {
        const invalid = combined.filter((value) => !supportedById.has(value));
        if (invalid.length > 0) {
            throw new UnsupportedAgentsSetupSelectionError(invalid);
        }
        return combined;
    }

    if (!isInteractiveTerminal()) {
        if (!args.includes('--yes')) {
            throw new Error('Non-interactive mode: pass one or more --provider <id> flags (or --yes to install the recommended defaults).');
        }
        return getAgentCliSetupRecommendedIds().filter(
            (id) => supportedById.has(id) && !supportedById.get(id)?.installed,
        );
    }

    const missingRows = supportedRows.filter((row) => !row.installed);
    const recommended = new Set<string>(getAgentCliSetupRecommendedIds());
    const installedTitles = supportedRows.filter((row) => row.installed).map((row) => row.title);
    const message = installedTitles.length > 0
        ? `Choose optional coding agents to add. Already installed: ${installedTitles.join(', ')}.`
        : 'Choose coding agents to install.';
    return await promptMultipleSelection(message, [
        ...missingRows.map((row) => ({
            id: row.id,
            label: `${row.title} (${row.id})`,
            description: row.runtimeSpec.managedInstall
                ? 'Happier-managed install'
                : row.runtimeSpec.manualInstallKind === 'vendor_recipe'
                    ? 'Runs the agent vendor installer'
                    : 'Uses the catalog install command',
            selected: recommended.has(row.id),
        })),
        { id: 'skip', label: 'Skip for now', kind: 'skip' as const },
    ]);
}

export async function handleAgentsCommand(args: string[]): Promise<void> {
    const json = wantsJson(args);
    const subcommand = String(args[0] ?? '').trim();
    const kind = (() => {
        if (!subcommand) return 'agents_unknown';
        if (subcommand === 'list') return 'agents_list';
        if (subcommand === 'status') return 'agents_status';
        if (subcommand === 'probe') return 'agents_probe';
        if (subcommand === 'auth') return 'agents_auth';
        if (subcommand === 'install') return 'agents_install';
        if (subcommand === 'setup') return 'agents_setup';
        return `agents_${subcommand}`;
    })();

    const needsAgentRegistry =
        subcommand === 'list'
        || subcommand === 'status'
        || subcommand === 'probe'
        || subcommand === 'auth'
        || subcommand === 'install'
        || subcommand === 'update'
        || subcommand === 'setup'
        || !subcommand
        || subcommand === 'help'
        || subcommand === '--help'
        || subcommand === '-h';
    const mergedRegistry = needsAgentRegistry
        ? await resolveMergedContributionRegistry({ happyHomeDir: configuration.happyHomeDir })
        : null;
    const agentRows = needsAgentRegistry
        ? listAgentStatus(mergedRegistry!, process.env)
        : [];
    const agentRowsById = new Map(agentRows.map((row) => [row.id, row] as const));

    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
        console.log(usage(agentRows));
        return;
    }

    if (subcommand === 'list' || subcommand === 'status') {
        if (json) {
            await printJsonEnvelope({
                ok: true,
                kind: subcommand === 'list' ? 'agents_list' : 'agents_status',
                data: {
                    agents: agentRows.map((row) => ({
                        id: row.id,
                        title: row.title,
                        installed: row.installed,
                        source: row.resolution?.source ?? null,
                        command: row.resolution?.command ?? null,
                    })),
                },
            });
            return;
        }
        printHumanStatus(agentRows);
        return;
    }

    if (subcommand === 'probe') {
        const agentId = String(args[1] ?? '').trim();
        if (!agentId || agentId === 'help' || agentId === '--help' || agentId === '-h') {
            console.log(usage(agentRows));
            return;
        }
        const agentRow = agentRowsById.get(agentId);
        if (!agentRow) {
            if (json) {
                await printUnknownAgentJsonEnvelope(kind, agentId);
                return;
            }
            throw new Error(`Unknown agent id: ${agentId}`);
        }

        const probeArgs = args.slice(2);
        const methods = parseAgentProbeMethods(probeArgs);
        const timeoutMs = parsePositiveIntFlag(probeArgs, '--timeout-ms') ?? parsePositiveIntFlag(probeArgs, '--timeout');
        const cwd = readSingleFlagValue(probeArgs, '--cwd') ?? readSingleFlagValue(probeArgs, '--path') ?? process.cwd();
        const { createCliCapabilitiesService } = await import('@/rpc/handlers/capabilities');
        const service = await createCliCapabilitiesService();
        const capabilityId = `cli.${agentId}` as CapabilityId;
        const probes: Record<string, unknown> = {};

        for (const method of methods) {
            const result = await service.invoke({
                id: capabilityId,
                method,
                params: {
                    cwd,
                    ...(timeoutMs ? { timeoutMs } : {}),
                },
            });
            if (!result.ok) {
                const code = typeof result.error?.code === 'string' ? result.error.code : 'probe_failed';
                const message = typeof result.error?.message === 'string' ? result.error.message : `Agent probe failed: ${method}`;
                if (json) {
                    await printJsonEnvelope({
                        ok: false,
                        kind,
                        error: { code, message, agentId, method },
                    }, { exitCode: 1 });
                    return;
                }
                throw new Error(message);
            }
            probes[agentProbeResultKey(method)] = result.result;
        }

        if (json) {
            await printJsonEnvelope({
                ok: true,
                kind,
                data: {
                    agentId,
                    title: agentRow.title,
                    probes,
                },
            });
            return;
        }

        const out = createOutputBuilder();
        out.line(ok(`${agentRow.title} ${dim(agentId)}`));
        for (const [key, value] of Object.entries(probes)) {
            const source = typeof (value as { source?: unknown })?.source === 'string'
                ? ` ${dim(`(${(value as { source: string }).source})`)}`
                : '';
            out.line(`  ${kv(`${key}:`, source ? source.trim() : 'ok')}`);
        }
        console.log(out.render());
        return;
    }

    if (subcommand === 'auth') {
        const action = String(args[1] ?? '').trim();
        const agentId = String(args[2] ?? '').trim();
        if (action !== 'login' || !agentId || args.includes('--help') || args.includes('-h')) {
            console.log(usage(agentRows));
            return;
        }
        const agentRow = agentRowsById.get(agentId);
        if (!agentRow || !mergedRegistry) {
            if (json) {
                await printUnknownAgentJsonEnvelope(kind, agentId);
                return;
            }
            throw new Error(`Unknown agent id: ${agentId}`);
        }
        const controller = new AbortController();
        const onInterrupt = () => controller.abort(new DOMException('Agent login cancelled', 'AbortError'));
        process.once('SIGINT', onInterrupt);
        process.once('SIGTERM', onInterrupt);
        try {
            const { authenticateDeclaredAcpAgent } = await import('@/agent/acp/authenticateDeclaredAcpAgent');
            console.log(`Signing in to ${agentRow.title}. Follow its browser login link if requested.`);
            await authenticateDeclaredAcpAgent({
                registry: mergedRegistry,
                agentId,
                cwd: process.cwd(),
                env: process.env,
                signal: controller.signal,
                onStderr: (text) => { process.stderr.write(text); },
            });
            console.log(`${agentRow.title} login completed.`);
        } finally {
            process.removeListener('SIGINT', onInterrupt);
            process.removeListener('SIGTERM', onInterrupt);
        }
        return;
    }

    if (subcommand === 'install' || subcommand === 'update') {
        const agentIdRaw = String(args[1] ?? '').trim();
        if (!agentIdRaw || agentIdRaw === 'help' || agentIdRaw === '--help' || agentIdRaw === '-h') {
            console.log(usage());
            return;
        }
        const agentRow = agentRowsById.get(agentIdRaw);
        if (!agentRow) {
            if (json) {
                await printUnknownAgentJsonEnvelope(kind, agentIdRaw);
                return;
            }
            throw new Error(`Unknown agent id: ${agentIdRaw}`);
        }
        if (!agentRow.runtimeSpec) {
            const message = `Agent '${agentIdRaw}' does not publish a CLI installation recipe.`;
            if (json) {
                await printJsonEnvelope({
                    ok: false,
                    kind,
                    error: { code: 'agent_install_unsupported', message, agentId: agentIdRaw },
                }, { exitCode: 1 });
                return;
            }
            throw new Error(message);
        }
        const flags = parseInstallFlags(args.slice(2));
        const result = await runAgentsInstall(agentRow.runtimeSpec, flags, subcommand, json);
        if (json) {
            if (result.ok) {
                await printJsonEnvelope(
                    {
                        ok: true,
                        kind,
                        data: {
                            agentId: agentIdRaw,
                            alreadyInstalled: result.alreadyInstalled ?? false,
                            plan: result.plan,
                            logPath: result.logPath ?? null,
                            jobId: result.jobId ?? null,
                            version: result.version ?? null,
                        },
                    },
                    { exitCode: 0 },
                );
                return;
            }
            await printJsonEnvelope(
                {
                    ok: false,
                    kind,
                    error: {
                        code: result.errorCode,
                        message: result.errorMessage,
                        logPath: result.logPath ?? null,
                        jobId: result.jobId ?? null,
                        ...(result.stepId ? { stepId: result.stepId } : {}),
                        ...(result.guideUrl ? { guideUrl: result.guideUrl } : {}),
                    },
                },
                { exitCode: 1 },
            );
            return;
        }

        if (!result.ok) {
            console.error(errorFrame('Error:', [result.errorMessage,
                ...(result.guideUrl ? [`Installation guide: ${result.guideUrl}`] : []),
                ...(result.logPath ? [`Install log: ${result.logPath}`] : []),
            ]));
            process.exitCode = 1;
            return;
        }

        const out = createOutputBuilder();
        if (flags.dryRun) {
            out.line(`Dry run: would ${subcommand} ${agentRow.title} via ${result.plan?.installMode ?? 'its catalog recipe'}.`);
        } else {
            out.line(ok(formatAgentInstallJobCompletion({ title: agentRow.title, version: result.version ?? null })));
        }
        if (result.logPath) out.line(`  ${kv('Install log:', result.logPath)}`);
        console.log(out.render());
        return;
    }

    if (subcommand === 'setup') {
        const flags = parseInstallFlags(args.slice(1));
        let agentIds: string[];
        try {
            agentIds = await resolveAgentsSetupSelection(args.slice(1), agentRows);
        } catch (error) {
            if (json && error instanceof UnsupportedAgentsSetupSelectionError) {
                await printJsonEnvelope({
                    ok: false,
                    kind,
                    error: {
                        code: error.code,
                        message: error.message,
                        agentIds: error.agentIds,
                    },
                }, { exitCode: 1 });
                return;
            }
            throw error;
        }
        if (agentIds.length === 0) {
            if (json) {
                await printJsonEnvelope({ ok: true, kind, data: { agents: [] } });
                return;
            }
            console.log(neutral('(no agents selected)'));
            return;
        }

        const installResults = [];
        for (const agentId of agentIds) {
            const agentRow = agentRowsById.get(agentId);
            if (!agentRow?.runtimeSpec) {
                throw new Error(`Agent '${agentId}' does not publish a CLI installation recipe.`);
            }
            const result = await runAgentsInstall(agentRow.runtimeSpec, flags, 'install', json);
            installResults.push({ agentId, title: agentRow.title, result });
        }
        // Installer completion is not executable readiness. Resolve again from
        // the canonical runtime catalog after every attempted installation.
        const refreshedRowsById = new Map(
            listAgentStatus(mergedRegistry!, process.env).map((row) => [row.id, row] as const),
        );
        const results = installResults.map((entry) => {
            const installed = refreshedRowsById.get(entry.agentId)?.installed === true;
            const detected = flags.dryRun || installed;
            return {
                ...entry,
                installed,
                ok: entry.result.ok && detected,
                errorMessage: !entry.result.ok
                    ? entry.result.errorMessage
                    : detected
                        ? null
                        : `Installation completed, but '${entry.agentId}' is still not resolvable. Open a new shell or run happier agents status, then retry.`,
            };
        });
        const allOk = results.every((entry) => entry.ok);

        if (json) {
            if (allOk) {
                await printJsonEnvelope(
                    {
                        ok: true,
                        kind,
                        data: {
                            agents: results.map((entry) => ({
                                agentId: entry.agentId,
                                ok: entry.ok,
                                installed: entry.installed,
                                alreadyInstalled: entry.result.ok ? entry.result.alreadyInstalled ?? false : null,
                                plan: entry.result.ok ? entry.result.plan : null,
                                logPath: entry.result.logPath ?? null,
                                errorMessage: entry.errorMessage,
                                jobId: entry.result.jobId ?? null,
                                version: entry.result.version ?? null,
                            })),
                        },
                    },
                    { exitCode: 0 },
                );
                return;
            }
            await printJsonEnvelope(
                {
                    ok: false,
                    kind,
                    error: {
                        code: 'install_failed',
                        agents: results.map((entry) => ({
                            agentId: entry.agentId,
                            ok: entry.ok,
                            installed: entry.installed,
                            alreadyInstalled: entry.result.ok ? entry.result.alreadyInstalled ?? false : null,
                            plan: entry.result.ok ? entry.result.plan : null,
                            logPath: entry.result.logPath ?? null,
                            errorMessage: entry.errorMessage,
                            jobId: entry.result.jobId ?? null,
                            errorCode: !entry.result.ok ? entry.result.errorCode : entry.ok ? null : 'verification_failed',
                            ...(!entry.result.ok && entry.result.guideUrl ? { guideUrl: entry.result.guideUrl } : {}),
                        })),
                    },
                },
                { exitCode: 1 },
            );
            return;
        }

        for (const entry of results) {
            const out = createOutputBuilder();
            if (entry.result.ok && entry.ok) {
                if (flags.dryRun) {
                    out.line(`Dry run: would install ${entry.title} via ${entry.result.plan?.installMode ?? 'its catalog recipe'}.`);
                } else {
                    out.line(ok(formatAgentInstallJobCompletion({ title: entry.title, version: entry.result.version ?? null })));
                }
                if (entry.result.logPath) out.line(`  ${kv('Install log:', entry.result.logPath)}`);
                console.log(out.render());
            } else {
                console.error(fail(`Failed to install ${entry.agentId}: ${entry.errorMessage}`));
                if (!entry.result.ok && entry.result.guideUrl) console.log(`  Installation guide: ${entry.result.guideUrl}`);
                if (entry.result.logPath) {
                    console.log(`  ${kv('Install log:', entry.result.logPath)}`);
                }
            }
        }

        if (!json && !flags.dryRun) {
            const connectableServiceIds = mergedRegistry
                ? Array.from(new Set(agentIds.flatMap((id) => (
                    resolveConnectTargetServiceIdsFromRegistry(id, mergedRegistry)
                ))))
                : [];
            if (connectableServiceIds.length > 0) {
                const out = createOutputBuilder();
                out.blank();
                out.line(sectionTitle('Next'));
                out.line(bullets(connectableServiceIds.map((serviceId) => (
                    `Connect ${serviceId} credentials in Happier Cloud: ${cmd(`happier connect ${serviceId}`)}`
                ))));
                console.log(out.render());
            }
        }

        if (!allOk) {
            process.exitCode = 1;
        }
        return;
    }

    if (json) {
        await printJsonEnvelope({ ok: false, kind, error: { code: 'unknown_subcommand' } }, { exitCode: 1 });
        return;
    }

    console.error(errorFrame('Error:', [`Unknown agents subcommand: ${subcommand}`]));
    console.log(usage());
    process.exitCode = 1;
}

export async function handleAgentsCliCommand(context: CommandContext): Promise<void> {
    try {
        await handleAgentsCommand(context.args.slice(1));
    } catch (error) {
        const args = context.args.slice(1);
        if (wantsJson(args)) {
            const subcommand = String(args[0] ?? '').trim();
            const kind = subcommand ? `agents_${subcommand}` : 'agents_unknown';
            await printJsonEnvelope(
                {
                    ok: false,
                    kind,
                    error: {
                        code: 'operation_failed',
                        message: error instanceof Error ? error.message : 'Unknown error',
                    },
                },
                { exitCode: 1 },
            );
            return;
        }
        console.error(errorFrame('Error:', [error instanceof Error ? error.message : 'Unknown error']));
        if (process.env.DEBUG) console.error(error);
        console.log(usage());
        process.exitCode = typeof process.exitCode === 'number' && process.exitCode > 1 ? process.exitCode : 1;
    }
}
