import { describe, expect, it } from 'vitest';
import type { AgentSessionOpenRequest, AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';
import { buildPluginSessionBindingInput } from '@/plugins/runtime/runtimeCore/plugin/sessionLaunch';
import { createNativeAgentRuntimeSessionPlan } from './nativeAgentSession';
import { createNativeSessionClientTestPort, createExternalContributionFixtures, createLease, createSessionHostServiceOwners } from './nativeAgentSession.testkit';

describe('native Agent Session skill delivery', () => {
    it.each(['create', 'resume'] as const)('delivers the host-owned folder through the %s open request', async kind => {
        const agentId = 'acme-skills-reader';
        const contributions = createExternalContributionFixtures(agentId);
        const requests: AgentSessionOpenRequest[] = [];
        // The native Agent is the external process boundary; host construction stays real.
        const nativeSession: AgentSessionRuntime = {
            send: async () => ({ status: 'admitted' }),
            watch: () => ({ dispose: () => undefined }), dispose: async () => undefined,
        };
        const plan = await createNativeAgentRuntimeSessionPlan({
            runtime: { sessions: { open: async request => { requests.push(request); return nativeSession; } } },
            lease: createLease(agentId), backend: contributions.backend, agent: contributions.agent,
            createSessionHostServiceOwners: () => createSessionHostServiceOwners(),
            sessionInput: buildPluginSessionBindingInput({
                credentials: { token: 'test-token', encryption: null },
                directory: '/tmp/skills-reader', backendTarget: { kind: 'backend', backendId: agentId },
                ...(kind === 'resume' ? { resume: 'vendor-session' } : {}),
            }),
        });
        const skills = { pluginRoot: '/skills/skills-reader', skillsRoot: '/skills/skills-reader/skills',
            items: [{ name: 'review', skillId: 'library-review', digest: 'sha256:review' }], nativeDisables: [] };
        if (!plan.config.createSessionRuntime) throw new Error('Missing native Session factory');
        const created = await plan.config.createSessionRuntime({
            directory: '/tmp/skills-reader', metadata: {}, machineId: 'machine-1',
            session: createNativeSessionClientTestPort('skills-reader'),
            transcriptSession: {}, messageBuffer: {}, mcpServers: {}, skills,
            permissionHandler: { cancelByPluginTurn: async () => undefined },
            getPermissionMode: () => 'default', memoryRecallGuidanceEnabled: false,
        } as never);
        try {
            expect(requests[0]?.kind).toBe(kind);
            expect(requests[0]?.skills).toEqual(skills);
        } finally { await created.operations.resetOrDisposeRuntime(); }
    });
});
