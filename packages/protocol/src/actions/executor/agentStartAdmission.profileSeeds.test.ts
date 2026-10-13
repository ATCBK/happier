import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '../actionExecutor.js';
import { createProfileActionExecuteV1 } from '../../profiles/profileActionsV1.js';
import { createProfileOperations } from '../../profiles/profileOperations.js';
import { ProfileRecordV1Schema } from '../../profiles/profileRecordSchemaV1.js';
import { SessionCapabilitySelectionAuthoringV1Schema } from '../../reach/sessionCapabilitySelectionV1.js';

describe('Profile seeds at new Session admission', () => {
  it('adds the captured Profile seeds once through the session level and keeps explicit exclusions', async () => {
    const profile = { v: 2, id: 'seed-profile', name: 'Seed Profile', createdAt: 1, updatedAt: 1 };
    const record = ProfileRecordV1Schema.parse({ v: 1, id: profile.id, definition: { kind: 'inline', profile },
      enabled: true, promptStack: [], secretBindings: {}, skillSeeds: ['lint', 'review'] });
    const profileActionExecute = createProfileActionExecuteV1({ operations: createProfileOperations({
      readCatalog: () => ({ status: 'ready', source: 'destination', authority: 'inactive', control: null,
        controlRevision: 'absent', records: [{ record, revision: 1 }], diagnostics: [], referenceGuardRevision: 1 }),
      writeRecord: async () => { throw new Error('Admission must not change the Profile'); },
      deleteRecord: async () => { throw new Error('Admission must not delete the Profile'); },
    }) });
    let spawned: Parameters<ActionExecutorDeps['sessionSpawnNew']>[0] | undefined;
    const executor = createActionExecutor({ profileActionExecute, sessionSpawnNew: async input => {
      spawned = input;
      return { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' };
    } });
    const input = { creationKey: 'seed-session', executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      profileId: profile.id, capabilitySelection: { skills: {
      v: 1, forceIncludeSkillIds: ['custom'], forceExcludeSkillIds: ['lint'], excludeNativeSkillNames: ['native'] },
      mcp: { v: 1, forceIncludeServerIds: [], forceExcludeServerIds: ['server'] } } };
    const admitted = await executor.execute('session.spawn_new', input, { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' }, serverId: 'home' });
    expect(admitted).toMatchObject({ ok: true });
    expect(spawned).toMatchObject({ capabilitySelection: { skills: {
      forceIncludeSkillIds: ['custom', 'review'], forceExcludeSkillIds: ['lint'], excludeNativeSkillNames: ['native'],
    }, mcp: input.capabilitySelection.mcp } });
    if (!admitted.ok) throw new Error('Expected admission');
    expect(SessionCapabilitySelectionAuthoringV1Schema.safeParse(spawned?.capabilitySelection).success).toBe(true);
  });
});
