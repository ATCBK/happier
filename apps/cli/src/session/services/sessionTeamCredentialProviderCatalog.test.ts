import { describe, expect, it } from 'vitest';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { TeamCredentialResourceReadInputV1Schema, TeamCredentialResourceCatalogEntryV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { readSessionTeamCredentialProviderModels } from './sessionTeamCredentialLaunch';

describe('Session Team runtime catalog', () => {
  it('qualifies a runtime open with the locally admitted external Agent application', async () => {
    const worker = await createManagedRunLaunchFixture();
    try {
      const application = { agentTargetKey: worker.agentTargetKey,
        implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
        endpointTemplateId: 'responses', protocol: 'openai-responses' };
      const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: 'resource', teamId: 'team', displayName: 'Team Pool', resourceRevision: 1,
        readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
        directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
        providerModels: [{ application, descriptor: { id: 'gpt-5.5' }, sourceRevision: 'source-v1', availability: 'available',
          selection: { kind: 'team_credential_provider_model', resourceId: 'resource', teamId: 'team',
            expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: worker.agentTargetKey, modelId: 'gpt-5.5' } }],
      });
      const seen: unknown[] = [];
      const rows = await readSessionTeamCredentialProviderModels({
        lease: worker.lease, agentId: worker.agentId, agentTargetKey: worker.agentTargetKey,
        resourceId: 'resource', teamId: 'team', signal: new AbortController().signal,
        homeDomainAction: async request => {
          const input = TeamCredentialResourceReadInputV1Schema.parse(request.input);
          seen.push(input);
          // Home cannot project a worker-only Agent without its application.
          return { resources: input.application ? [resource] : [], nextCursor: null };
        },
      });
      expect(rows).toEqual(resource.providerModels);
      expect(seen).toEqual([{ teamId: 'team', application: {
        agentTargetKey: worker.agentTargetKey,
        implementationIdentity: { pluginId: 'acme.managed-run', localId: 'gateway' },
        endpointTemplateId: 'responses', protocol: 'openai-responses',
      } }]);
    } finally { await worker.cleanup(); }
  });
});
