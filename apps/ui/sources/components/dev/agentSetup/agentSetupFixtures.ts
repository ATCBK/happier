import type { MachineAgent, MachineAgentSignInSession } from '@/agents/machineAgents/machineAgentTypes';

/**
 * The lab `agent-setup` machine (`devbox`, Linux x86_64) as inventory rows, for the dev specimen's side
 * by side pairs. Illustration data only; never product state.
 */
const MB = 1_000_000;

const noSignIn = { status: 'unknown', via: null, nativeLogin: 'terminal', connectedServices: [] } as const;
const managed = { available: true, mode: 'managed', sizeBytes: null, guideUrl: 'https://happier.dev/docs/agents', requiresVendorConsent: false } as const;

function agent(input: Partial<MachineAgent> & Pick<MachineAgent, 'agentId' | 'title'>): MachineAgent {
    return {
        state: 'notInstalled',
        installed: false,
        version: null,
        latestVersion: null,
        update: null,
        signIn: noSignIn,
        platform: { supported: true },
        install: managed,
        dependencies: [],
        job: null,
        stale: false,
        ...input,
    };
}

export const FIXTURE_AGENTS: Readonly<Record<'claude' | 'codex' | 'opencode' | 'gemini' | 'antigravity' | 'cursor' | 'kimi' | 'qwen', MachineAgent>> = {
    claude: agent({
        agentId: 'claude', title: 'Claude Code', state: 'ready', installed: true, version: '2.1.278',
        signIn: {
            status: 'signedIn',
            via: { kind: 'connected', serviceId: 'claude-subscription', title: 'Claude subscription', profileLabel: 'Work · Max' },
            nativeLogin: 'terminal',
            connectedServices: [{ serviceId: 'claude-subscription', title: 'Claude subscription', connected: true, healthy: true, profileLabel: 'Work · Max' }],
        },
    }),
    codex: agent({
        agentId: 'codex', title: 'Codex', state: 'updateAvailable', installed: true, version: '0.155.1', latestVersion: '0.157.0',
        update: { supported: true, command: null },
        signIn: { status: 'signedIn', via: { kind: 'native', accountLabel: null }, nativeLogin: 'terminal', connectedServices: [] },
    }),
    opencode: agent({
        agentId: 'opencode', title: 'OpenCode', state: 'needsSignIn', installed: true, version: '1.18.4',
        signIn: {
            status: 'signedOut', via: null, nativeLogin: 'terminal',
            connectedServices: [{ serviceId: 'claude-subscription', title: 'Claude subscription', connected: true, healthy: true, profileLabel: 'Work · Max' }],
        },
    }),
    gemini: agent({
        agentId: 'gemini', title: 'Gemini CLI', install: { ...managed, sizeBytes: 42 * MB },
        signIn: {
            status: 'unknown', via: null, nativeLogin: 'unsupported',
            connectedServices: [{ serviceId: 'gemini-account', title: 'Gemini account', connected: true, healthy: true, profileLabel: 'leeroy@gmail.com' }],
        },
    }),
    antigravity: agent({
        agentId: 'antigravity', title: 'Antigravity',
        install: { available: true, mode: 'vendor_recipe', sizeBytes: 680 * MB, guideUrl: 'https://antigravity.google/docs', requiresVendorConsent: true },
        dependencies: [{ key: 'dep.antigravity.agy-acp-server', title: 'the Antigravity ACP server', installed: false, version: null }],
    }),
    cursor: agent({
        agentId: 'cursor', title: 'Cursor Agent',
        install: { available: false, mode: 'manual', sizeBytes: null, guideUrl: 'https://cursor.com/cli', requiresVendorConsent: false },
        signIn: { ...noSignIn, nativeLogin: 'statusOnly' },
    }),
    kimi: agent({ agentId: 'kimi', title: 'Kimi CLI' }),
    qwen: agent({ agentId: 'qwen', title: 'Qwen Code' }),
} as const satisfies Record<string, MachineAgent>;

export const IDLE_SESSION: MachineAgentSignInSession = { phase: 'idle', terminalKey: null, authUrl: null, startedAtMs: null, failure: null };

export function waitingSession(authUrl: string | null = 'https://accounts.google.com/o/oauth2/auth?client_id=agy&code_challenge=Qm9vdA'): MachineAgentSignInSession {
    return { phase: 'waiting', terminalKey: 'provider-login:devbox:antigravity', authUrl, startedAtMs: Date.now() - 37_000, failure: null };
}

export const SIGNED_IN_SESSION: MachineAgentSignInSession = { phase: 'signedIn', terminalKey: 'provider-login:devbox:antigravity', authUrl: null, startedAtMs: null, failure: null };

export function installingAntigravity(): MachineAgent {
    return {
        ...FIXTURE_AGENTS.antigravity,
        state: 'installing',
        job: {
            jobId: 'fixture-job', intent: 'install', startedAtMs: Date.now() - 25_000,
            logLine: 'agy_acp_server_1.1.1-linux-x86_64.zip  259 of 680 MB · 11 MB/s',
            outcome: null,
            steps: [
                { stepId: 'cli', label: 'Install the Antigravity CLI (Google’s installer)', state: 'done', bytesDone: null, bytesTotal: null },
                { stepId: 'dep.antigravity.agy-acp-server', label: 'Download the Antigravity ACP server', state: 'running', bytesDone: 259 * MB, bytesTotal: 680 * MB },
                { stepId: 'check', label: 'Check that it runs', state: 'pending', bytesDone: null, bytesTotal: null },
            ],
        },
    };
}

export function failedGemini(): MachineAgent {
    return {
        ...FIXTURE_AGENTS.gemini,
        state: 'failed',
        job: {
            jobId: 'fixture-job-2', intent: 'install', startedAtMs: Date.now() - 60_000, logLine: null,
            steps: [
                { stepId: 'download', label: 'Download Gemini CLI 0.9.2', state: 'failed', bytesDone: null, bytesTotal: null },
                { stepId: 'check', label: 'Check that it runs', state: 'pending', bytesDone: null, bytesTotal: null },
            ],
            outcome: { kind: 'failed', code: 'download_failed', stepId: 'download', message: 'devbox couldn’t reach the package registry.' },
        },
    };
}

export function justInstalledGemini(): MachineAgent {
    return {
        ...FIXTURE_AGENTS.gemini,
        state: 'needsSignIn', installed: true, version: '0.9.2',
        job: { jobId: 'fixture-job-3', intent: 'install', startedAtMs: Date.now() - 90_000, logLine: null, steps: [], outcome: { kind: 'succeeded', version: '0.9.2' } },
    };
}

export function readyAntigravity(): MachineAgent {
    return {
        ...FIXTURE_AGENTS.antigravity,
        state: 'ready', installed: true, version: '1.1.1',
        dependencies: [{ key: 'dep.antigravity.agy-acp-server', title: 'the Antigravity ACP server', installed: true, version: '1.1.1' }],
        signIn: { status: 'signedIn', via: { kind: 'native', accountLabel: 'leeroy@gmail.com' }, nativeLogin: 'terminal', connectedServices: [] },
    };
}

export const DEVBOX_AGENTS: readonly MachineAgent[] = [
    FIXTURE_AGENTS.claude,
    FIXTURE_AGENTS.codex,
    FIXTURE_AGENTS.opencode,
    FIXTURE_AGENTS.gemini,
    FIXTURE_AGENTS.antigravity,
    FIXTURE_AGENTS.cursor,
    FIXTURE_AGENTS.kimi,
    FIXTURE_AGENTS.qwen,
];
