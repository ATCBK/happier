import { afterEach, describe, expect, it } from 'vitest';
import retained from '../../../../../../packages/protocol/fixtures/0.2-retained-skill-path.json';
import retainedFrontmatter from '../../../../../../packages/protocol/fixtures/0.2-retained-skill-frontmatter.json';
import { PromptBundleBodyV1Schema, readSkillBundleContentV1, validatePromptBundleBodyV1AgainstSchemaId } from '@happier-dev/protocol/prompts/library/promptBundleSchemas';
import { readSkillLibraryCatalog } from '@happier-dev/protocol/prompts/library/skills/readSkillLibraryCatalog';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { ensureSkillSessionDirHttp } from '@/daemon/controlClient';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
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
  it.each(['linux', 'win32'] as const)('reads the predecessor bundle through the catalog and authenticated daemon Session delivery on %s', async platform => {
    const f = await fixture();
    const retainedArtifact = { ...bundle('library', 'retained'), header: retained.header, body: JSON.stringify(retained.body) };
    const healthy = bundle('healthy', 'healthy');
    const legacy = retainedFrontmatter.cases.find(item => item.id === 'unquoted-colon')!;
    const legacyArtifact = { ...bundle('legacy', legacy.expectedName), header: legacy.header, body: JSON.stringify(legacy.body) };
    const artifacts: SkillArtifactStore = { list: async () => ({ items: [retainedArtifact, healthy, legacyArtifact], coverage: 'complete' }),
      read: async id => id === 'library' ? retainedArtifact : id === 'legacy' ? legacyArtifact : healthy };
    const input = { ...f.input, accountSnapshot: { ...f.input.accountSnapshot!, promptLibraryCatalog: { status: 'ready' as const,
      rows: [{ revision: 1, record: { key: 'skill-rules' as const, value: { v: 1 as const, rules: ['library', 'healthy', 'legacy'].map(skillId => ({
        id: `everywhere-${skillId}`, skillId, target: { t: 'allMachines' as const }, enabled: true, createdAt: 1, updatedAt: 1,
      })) } } }], tombstones: [], diagnostics: [] } } };
    const opened = readSkillBundleContentV1(retainedArtifact);
    expect(opened?.frontmatter.name).toBe('retained');
    expect(validatePromptBundleBodyV1AgainstSchemaId({ bundleSchemaId: 'skills.skill_md_v1', body: PromptBundleBodyV1Schema.parse(retained.body) }))
      .toMatchObject({ ok: false, errorCode: 'invalid_path', path: 'refs/CON.txt' });
    expect(await readSkillLibraryCatalog(artifacts)).toContainEqual({ id: 'library', name: 'retained' });
    expect(await readSkillLibraryCatalog(artifacts)).toContainEqual({ id: 'legacy', name: legacy.expectedName });
    const store = createSkillStore({ happyHomeDir: join(f.home, 'retained-store'), platform }); stores.push(store);
    const app = createDaemonControlApp({ getChildren: () => [], machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'retained-test', skillStore: store });
    const url = await app.listen({ port: 0, host: '127.0.0.1' });
    const target = { httpPort: Number(new URL(url).port), controlToken: 'retained-test' };
    try {
      const result = await resolveRunnerSkills(input, { artifacts,
        ensureSessionDir: content => ensureSkillSessionDirHttp(content, { target }) });
      if (platform === 'win32') {
        expect(result.delivery?.items).toEqual([expect.objectContaining({ skillId: 'healthy', name: 'healthy' }),
          expect.objectContaining({ skillId: 'legacy', name: legacy.expectedName })]);
        expect(await readFile(join(result.delivery!.skillsRoot, 'healthy', 'references', 'note.md'), 'utf8')).toBe('Supporting file');
        expect(result.plan.items.find(item => item.skillId === 'library')).toMatchObject({ state: 'unavailable', reason: 'materialize_failed' });
        expect(result.failureDetails).toEqual([{ skillId: 'library', detail: 'invalid_path' }]);
      } else {
        expect(result.delivery?.items).toEqual(expect.arrayContaining([{ skillId: 'library', name: 'retained', digest: opened!.digest },
          expect.objectContaining({ skillId: 'healthy', name: 'healthy' }),
          expect.objectContaining({ skillId: 'legacy', name: legacy.expectedName })]));
        expect(await readFile(join(result.delivery!.skillsRoot, 'retained', 'refs', 'CON.txt'), 'utf8')).toBe('Retained supporting bytes');
        expect(AgentRuntimeDaemonSessionOpenRequestV1Schema.parse({ kind: 'create', sessionId: 'session', cwd: f.directory,
          skills: result.delivery }).skills).toEqual(result.delivery);
      }
      expect(await readFile(join(result.delivery!.skillsRoot, legacy.expectedName, 'SKILL.md'), 'utf8')).toBe(legacy.input.skillMarkdown);
    } finally { await app.close(); }
  });
  it.each(['body', 'base64', 'header'] as const)('keeps a malformed stored %s out of the shared name catalog while a valid neighbour remains deliverable', async fault => {
    const f = await fixture();
    const good = bundle('library', 'sample');
    const bad = fault === 'header' ? { ...bundle('bad', 'bad'), header: { ...good.header, title: '' } }
      : { ...bundle('bad', 'bad'), body: fault === 'body' ? '{malformed' : JSON.stringify({ ...retained.body,
        entries: retained.body.entries.map(entry => entry.path === 'SKILL.md' ? { ...entry, contentBase64: '!' } : entry) }) };
    const artifacts: SkillArtifactStore = { list: async () => ({ items: [bad, good], coverage: 'complete' }),
      read: async id => id === 'bad' ? bad : good };
    expect(await readSkillLibraryCatalog(artifacts)).toContainEqual({ id: 'library', name: 'sample' });
    expect(await readSkillLibraryCatalog(artifacts)).not.toContainEqual(expect.objectContaining({ id: 'bad' }));
    const result = await resolveRunnerSkills({ ...f.input, sessionMetadata: {
      skillSelectionV1: { v: 1, forceIncludeSkillIds: ['bad'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
    } }, { artifacts, ensureSessionDir: value => f.store.ensureSkillSessionDir(value) });
    expect(result.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library' })]);
    expect(result.plan.items.find(item => item.skillId === 'bad')).toMatchObject({ state: 'unavailable', reason: 'content_unreadable' });
  });
  it('uses the same realpath preparation as MCP for linked workspace roots without matching a sibling prefix', async () => {
    const { input, artifacts, store, home, directory } = await fixture();
    const linked = join(home, 'linked');
    await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const skills = { items: [{ skillId: 'library', name: 'sample' }], rules: [{ id: 'folder', skillId: 'library',
      target: { t: 'workspace' as const, machineId: 'machine', workspaceRoot: linked }, enabled: true, createdAt: 1, updatedAt: 1 }] };
    const accountSnapshot = { ...input.accountSnapshot!, promptLibraryCatalog: { status: 'ready' as const,
      rows: [{ revision: 2 as const, record: { key: 'skill-rules' as const, value: { v: 1 as const, rules: skills.rules } } }], tombstones: [], diagnostics: [] } };
    const { resolveSessionCapabilitiesForDirectory } = await import('@/mcp/servers/resolveSessionCapabilitiesForDirectory');
    const mcp = { v: 1 as const, strictMode: false, servers: [{ id: 'server', name: 'server', transport: 'http' as const,
      remote: { url: 'https://example.test/mcp', headers: {} }, env: {}, createdAt: 1, updatedAt: 1 }],
      bindings: skills.rules.map(rule => ({ ...rule, serverId: 'server' })) };
    const preview = resolveSessionCapabilitiesForDirectory({ settings: mcp, skills, machineId: 'machine', directory, agentAcceptsUserMcp: true });
    expect(preview.mcp.items[0]).toMatchObject({ selected: true, reason: 'rule_on' });
    expect(preview.skills.items[0]).toMatchObject({ selected: true, reason: 'rule_on' });
    const resolved = await resolveRunnerSkills({ ...input, accountSnapshot }, { artifacts, ensureSessionDir: value => store.ensureSkillSessionDir(value) });
    expect(resolved.delivery?.items).toEqual([expect.objectContaining({ skillId: 'library' })]);
    const sibling = `${directory}2`; await mkdir(sibling);
    const adjacent = await resolveRunnerSkills({ ...input, directory: sibling, accountSnapshot }, { artifacts, ensureSessionDir: value => store.ensureSkillSessionDir(value) });
    expect(adjacent.delivery?.items).toEqual([]);
    expect(skills.rules[0]!.target.workspaceRoot).toBe(linked);
  });
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
