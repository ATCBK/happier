import { AGENT_IDS, isAgentCliAuthBackgroundCheckSafe } from '@happier-dev/agents';
import { CHECKLIST_IDS } from '@happier-dev/protocol/checklists';
import { describe, expect, it } from 'vitest';

import { buildProviderCliCapabilityId } from './cliCapabilityId';
import { CAPABILITIES_REQUEST_MACHINE_DETAILS, buildUpdatesCapabilitiesRequest } from './requests';

describe('CAPABILITIES_REQUEST_MACHINE_DETAILS', () => {
    it('asks for the machine-details checklist and login status only for agents whose auth check is background-safe', () => {
        expect(CAPABILITIES_REQUEST_MACHINE_DETAILS.checklistId).toBe(CHECKLIST_IDS.MACHINE_DETAILS);
        const overrides = CAPABILITIES_REQUEST_MACHINE_DETAILS.overrides ?? {};
        for (const agentId of AGENT_IDS) {
            const override = (overrides as Record<string, unknown>)[buildProviderCliCapabilityId(agentId)];
            if (isAgentCliAuthBackgroundCheckSafe(agentId)) expect(override).toEqual({ params: { includeLoginStatus: true } });
            else expect(override).toBeUndefined();
        }
    });
});

describe('buildUpdatesCapabilitiesRequest', () => {
    it('asks for every agent CLI latest version, the system-task kinds and the helper requests', () => {
        const request = buildUpdatesCapabilitiesRequest([{ requests: [{ id: 'dep.gh', params: { includeLatestVersion: true } }] }]);
        expect(request.requests).toEqual([
            ...AGENT_IDS.map((agentId) => ({ id: buildProviderCliCapabilityId(agentId), params: { includeLatestVersion: true } })),
            { id: 'tool.systemTasks' },
            { id: 'dep.gh', params: { includeLatestVersion: true } },
        ]);
    });
});
