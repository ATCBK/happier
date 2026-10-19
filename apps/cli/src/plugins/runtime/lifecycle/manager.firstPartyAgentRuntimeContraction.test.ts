import { AGENT_IDS } from '@happier-dev/agents';
import { describe, expect, it } from 'vitest';

import { isPrimaryAgentContributionDefinition } from '@/plugins/projection/registry/agentContributionDefinition';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
const V1_COMPATIBILITY_FACTORY_SYMBOL =
    'happier.plugin-sdk.agentRuntimeV1CompatibilityFactory';

describe('first-party AgentRuntime contraction', () => {
    it('activates every bundled Agent as a native runtime with no V1 compatibility owner', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture();
        const activated = fixture.registry;
        const contributes = activated.contributes;

        try {
            const demands = AGENT_IDS.map((agentId) => {
                const contribution = contributes.agents.find((entry) => entry.id === agentId);
                expect(contribution?.pluginId, agentId).toBeTruthy();
                expect(contribution?.identity, agentId).toBeTruthy();
                if (!contribution?.pluginId || !contribution.identity) {
                    throw new Error(`Missing bundled contribution identity for '${agentId}'`);
                }
                return {
                    pluginId: contribution.pluginId,
                    family: 'agents' as const,
                    localId: contribution.identity.localId,
                };
            });

            const results = await activated.activateContributionsOnDemand(demands);
            expect(results.every((result) => result.diagnostics.length === 0)).toBe(true);

            for (const agentId of AGENT_IDS) {
                const lease = activated.agentRuntimesByAgentId.get(agentId);
                expect(lease, agentId).toMatchObject({
                    agentId,
                    hasPrimaryRuntime: true,
                });
                if (!lease?.hasPrimaryRuntime) {
                    throw new Error(`Missing primary runtime lease for '${agentId}'`);
                }

                const runtime = await lease.createRuntime({
                    signal: new AbortController().signal,
                });
                const definition = contributes.agents.find((entry) => entry.id === agentId)
                    ?.richDefinition?.definition;
                if (!definition || !isPrimaryAgentContributionDefinition(definition)) {
                    throw new Error(`Missing primary Agent definition for '${agentId}'`);
                }
                expect(
                    Object.getOwnPropertySymbols(runtime).map((symbol) => Symbol.keyFor(symbol)),
                    agentId,
                ).not.toContain(V1_COMPATIBILITY_FACTORY_SYMBOL);
                expect(runtime.sessions !== undefined, `${agentId}: sessions capability`)
                    .toBe(definition.primary === 'sessions');
                expect(runtime.executionRuns !== undefined, `${agentId}: execution-runs capability`)
                    .toBe(definition.primary === 'executionRuns');
                expect(runtime.surfaces?.terminal !== undefined, `${agentId}: terminal capability`)
                    .toBe(definition.capabilities.surfaces?.includes('terminal') === true);
            }
        } finally {
            await fixture.dispose();
        }
    });
});
