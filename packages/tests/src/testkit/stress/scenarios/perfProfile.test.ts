import { describe, expect, it } from 'vitest';
import { WorkflowDefinitionArtifactBodyV1Schema, WorkflowDefinitionArtifactHeaderV1Schema } from '@happier-dev/protocol';
import { buildPerfProfile } from './perfProfile';

describe('performance journey data profile', () => {
  it('repeats a realistic fleet and long transcripts without depending on private Accounts', () => {
    const profile = buildPerfProfile(42);
    expect(profile).toEqual(buildPerfProfile(42));
    expect(profile).not.toEqual(buildPerfProfile(43));
    expect(profile.machines).toHaveLength(137);
    expect(profile.sessions).toHaveLength(192);
    expect(new Set(profile.sessions.map(session => session.machineIndex)).size).toBe(137);
    expect(profile.sessions.filter(session => session.messages.length >= 500).length).toBeGreaterThan(0);
    expect(new Set(profile.machines.map(machine => machine.platform))).toEqual(new Set(['linux', 'darwin', 'win32']));
    expect(profile.artifacts.length).toBeGreaterThan(0);
    expect(profile.workflows.length).toBeGreaterThan(0);
    for (const row of [...profile.machines, ...profile.artifacts, ...profile.workflows]) {
      expect(row.id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    }
    for (const workflow of profile.workflows) {
      expect(WorkflowDefinitionArtifactHeaderV1Schema.safeParse(workflow.header).success).toBe(true);
      expect(WorkflowDefinitionArtifactBodyV1Schema.safeParse(workflow.body).success).toBe(true);
    }
  });
});
