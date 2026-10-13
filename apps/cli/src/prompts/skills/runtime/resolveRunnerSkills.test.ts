import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createSkillStore } from '../store/skillStore';
import { resolveRunnerSkills, type ResolveRunnerSkillsInput } from './resolveRunnerSkills';
import type { SkillArtifactStore } from '../library/readSkillLibraryContent';
import type { AccountArtifact } from '@/api/artifacts/accountArtifactStore';
import {
  AgentRuntimeDaemonSessionOpenRequestV1Schema,
  AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema,
  projectAgentRuntimeDaemonSessionOpenAttestationRequestV1,
} from '@/agent/runtime/session/process/agentRuntimeRunnerProtocol';

const dirs: string[] = [];
const stores: ReturnType<typeof createSkillStore>[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.releaseSkillSessionDirs('session');
    await store.collectSkillCache({ libraryDigests: [] });
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
const bundle = (artifactId: string, name: string): AccountArtifact => ({
  artifactId, ownerAccountId: 'account', access: 'owner', revision: { headerVersion: 1, bodyVersion: 1 }, seq: 1, createdAt: 1, updatedAt: 1,
  header: { v: 1, kind: 'prompt_bundle.v2', title: 'Display title', bundleSchemaId: 'skills.skill_md_v1' },
  body: JSON.stringify({ v: 1, createdAtMs: 1, updatedAtMs: 1, entries: [
    { path: 'SKILL.md', contentKind: 'utf8', contentBase64: Buffer.from(`---\nname: ${name}\ndescription: Useful\n---\nFull body`).toString('base64') },
    { path: 'references/note.md', contentKind: 'utf8', contentBase64: Buffer.from('Supporting file').toString('base64'), retainedAnnotation: 'read-only extension' },
  ] }),
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'happier-p3b-runner-')); dirs.push(home);
  const directory = join(home, 'project'); await mkdir(directory);
  const artifact = bundle('library', 'sample');
  const readIds: string[] = [];
  // Artifact persistence and daemon HTTP are genuine external boundaries; the store, scan and selection remain real.
  const artifacts: SkillArtifactStore = {
    list: async () => ({ items: [artifact, bundle('off', 'off')], coverage: 'complete' }),
    read: async id => { readIds.push(id); return id === 'library' ? artifact : bundle('off', 'off'); },
  };
  const store = createSkillStore({ happyHomeDir: join(home, 'happier') });
  stores.push(store);
  const input: ResolveRunnerSkillsInput = {
    ownerKey: 'session', agentId: 'test', machineId: 'machine', directory, home,
    credentials: { token: 'token', encryption: null }, sessionMetadata: {}, agentHasActionChannel: true,
    contributes: { catalogEntriesById: { test: { skills: { delivery: 'session_dir', nativeDisable: 'supported', liveReload: 'supported' } } } },
    accountSnapshot: { source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
      promptLibraryCatalog: { status: 'ready', rows: [{ revision: 1, record: { key: 'skill-rules', value: { v: 1, rules: [
        { id: 'everywhere', skillId: 'library', target: { t: 'allMachines' }, enabled: true, createdAt: 1, updatedAt: 1 },
      ] } } }], tombstones: [], diagnostics: [] } },
  };
  return { home, directory, input, artifacts, store, readIds };
}
describe('runner skill resolution', () => {
  it('consumes P2 selection and daemon materialization while reading only selected bodies', async () => {
    const { input, artifacts, store, readIds } = await fixture();
    const result = await resolveRunnerSkills(input, { artifacts, ensureSessionDir: value => store.ensureSkillSessionDir(value) });
    expect(result.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library', name: 'sample' })]);
    expect(readIds).toEqual(['library']);
    expect(result.plan.items.find(item => item.skillId === 'off')?.state).toBe('off');
    expect(result.indexItems).toEqual([]);
    expect(await readFile(join(result.delivery!.skillsRoot, 'sample', 'references', 'note.md'), 'utf8')).toBe('Supporting file');
    const request = { kind: 'create' as const, sessionId: input.ownerKey, cwd: input.directory, skills: result.delivery };
    expect(AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(request).skills).toEqual(result.delivery);
    expect(AgentRuntimeDaemonSessionOpenAttestationRequestV1Schema.parse(
      projectAgentRuntimeDaemonSessionOpenAttestationRequestV1(request),
    )).toEqual({ kind: 'create', sessionId: input.ownerKey, cwd: input.directory });
  });
  it('keeps the session startable and marks daemon failure visibly', async () => {
    const { input, artifacts } = await fixture();
    const result = await resolveRunnerSkills(input, { artifacts, ensureSessionDir: async () => { throw new Error('daemon_unreachable'); } });
    expect(result.delivery).toBeUndefined();
    expect(result.unavailable).toBe(true);
    expect(result.plan.items[0]).toMatchObject({ state: 'unavailable', reason: 'materialize_failed' });
    expect(result.unavailableReason).toBe('materialize_failed');
  });
  it('retains a failed skill-rules read as the reason even before item resolution', async () => {
    const { input, artifacts } = await fixture();
    const result = await resolveRunnerSkills({ ...input, accountSnapshot: { ...input.accountSnapshot!,
      promptLibraryCatalog: { status: 'unavailable', reason: 'invalid-stored-content' },
    } }, { artifacts });
    expect(result).toMatchObject({ unavailable: true, unavailableReason: 'invalid-stored-content' });
    expect(result.delivery).toBeUndefined();
  });
  it('still delivers readable selected skills at startup when another selected body is unavailable', async () => {
    const { input, artifacts, store } = await fixture();
    const unavailable = bundle('unavailable', 'missing');
    const result = await resolveRunnerSkills({ ...input, sessionMetadata: {
      skillSelectionV1: { v: 1, forceIncludeSkillIds: ['unavailable'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
    } }, { artifacts: {
      list: async () => ({ items: [...(await artifacts.list()).items, unavailable], coverage: 'complete' }),
      read: async id => { if (id === 'unavailable') throw new Error('body_unavailable'); return artifacts.read(id); },
    }, ensureSessionDir: value => store.ensureSkillSessionDir(value) });
    expect(result.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library', name: 'sample' })]);
    expect(result.plan.items.find(item => item.skillId === 'unavailable')).toMatchObject({ state: 'unavailable', reason: 'content_unreadable' });
    expect(await readFile(join(result.delivery!.skillsRoot, 'sample', 'references', 'note.md'), 'utf8')).toBe('Supporting file');
  });
  it('retains the daemon filesystem failure code without disclosing a partial skill', async () => {
    const { input, artifacts } = await fixture();
    const result = await resolveRunnerSkills(input, { artifacts, ensureSessionDir: async () => ({
      pluginRoot: '/session', skillsRoot: '/session/skills', failed: [{ skillId: 'library', reason: 'materialize_failed', detail: 'EACCES' }],
    }) });
    expect(result.delivery?.items).toEqual([]);
    expect(result.failureDetails).toEqual([{ skillId: 'library', detail: 'EACCES' }]);
    expect(AgentRuntimeDaemonSessionOpenRequestV1Schema.parse({
      kind: 'resume', sessionId: input.ownerKey, cwd: input.directory, providerSessionId: 'native-session', skills: result.delivery,
    }).skills).toEqual(result.delivery);
  });
  it('withholds uncertain native masking after a failed root and never asks the daemon to deliver', async () => {
    const { input, artifacts } = await fixture();
    await writeFile(join(input.home!, '.native'), 'This root is a file');
    const result = await resolveRunnerSkills({ ...input, contributes: { catalogEntriesById: { test: {
      skills: { ...input.contributes!.catalogEntriesById.test!.skills!, nativeRoots: { user: [['.native']] } },
    } } } }, { artifacts, ensureSessionDir: async () => { throw new Error('must_not_deliver'); } });
    expect(result.plan.items[0]).toMatchObject({ state: 'unavailable', reason: 'native_scan_failed' });
    expect(result.plan.diagnostics).toHaveLength(1);
  });
  it('does not open Account content without Account credentials, and does not turn partial inventory into empty', async () => {
    const { input, artifacts } = await fixture();
    const scoped = await resolveRunnerSkills({ ...input, credentials: null }, { artifacts: { ...artifacts, list: async () => { throw new Error('must_not_read'); } } });
    expect(scoped.delivery).toBeUndefined();
    const failed = await resolveRunnerSkills(input, { artifacts: { ...artifacts, list: async () => ({ items: [], coverage: 'partial' }) } });
    expect(failed.unavailable).toBe(true);
    expect(failed.unavailableReason).toBe('skill_library_unavailable');
  });
  it('serves an index without materializing a folder and without embedding skill bodies', async () => {
    const { input, artifacts } = await fixture();
    const result = await resolveRunnerSkills({ ...input, contributes: { catalogEntriesById: {} } }, { artifacts });
    expect(result.plan.plan).toBe('index');
    expect(result.indexItems).toEqual([expect.objectContaining({ skillId: 'library', name: 'sample', description: 'Useful' })]);
    expect(result.delivery).toBeUndefined();
  });
});
