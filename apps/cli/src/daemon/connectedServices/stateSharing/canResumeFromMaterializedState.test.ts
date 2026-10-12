import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import fileSystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveTrackedConnectedServiceSwitchContinuityContext } from '../sessionAuthSwitch/resolveTrackedConnectedServiceSwitchContinuityContext';
import { canResumeFromMaterializedState } from './canResumeFromMaterializedState';

describe('canResumeFromMaterializedState', () => {
  let runtime: Awaited<ReturnType<typeof createAdmittedPluginRuntimeFixture>>;
  beforeAll(async () => {
    runtime = await createAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
      runtimeOptions: { pluginIds: ['happier.agent.codex', 'happier.agent.pi', 'happier.agent.opencode'] } });
  });
  afterAll(async () => { await runtime?.dispose(); });

  it.each(['persisted candidate', 'manifest mapping', 'archived rollout'] as const)(
    'does not prove target resume reachability from a %s', async (evidence) => {
      const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-target-'));
      const vendorResumeId = '019c1234-1234-7123-8123-123456789abc';
      try {
        const target = join(root, 'target');
        const store = evidence === 'archived rollout' ? join(target, 'archived_sessions') : join(root, 'old', 'sessions');
        await mkdir(target, { recursive: true });
        await mkdir(store, { recursive: true });
        const rollout = join(store, `rollout-2026-10-11T12-00-00-${vendorResumeId}.jsonl`);
        await writeFile(rollout, '{}\n');
        await expect(canResumeFromMaterializedState({
          agentId: 'codex', serviceId: 'openai-codex', targetMaterializedRoot: target,
          requestedStateMode: 'isolated', effectiveStateMode: 'isolated',
          materializationIdentity: { v: 1, id: 'csm_target' }, vendorResumeId, cwd: '/tmp/project',
          ...(evidence === 'persisted candidate' ? { candidatePersistedSessionFile: rollout } : {}),
          ...(evidence === 'manifest mapping' ? { manifest: {
            v: 1 as const, requestedStateMode: 'isolated' as const, effectiveStateMode: 'isolated' as const,
            lastSyncAtMs: Date.now(), configEntries: [], stateEntries: [], diagnostics: [],
            sessionFileMappings: [{ vendorResumeId, sourcePath: null, destinationPath: rollout, importedAtMs: Date.now(), verifiedAtMs: null }],
          } } : {}),
        })).resolves.toMatchObject({ ok: false, reason: 'codex_session_file_not_found' });
      } finally { await rm(root, { recursive: true, force: true }); }
    },
  );

  it('accepts native rollout state linked into the target declared sessions store', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-linked-'));
    const vendorResumeId = '019c1234-1234-7123-8123-123456789abc';
    try {
      const target = join(root, 'target');
      const native = join(root, 'native-sessions');
      await mkdir(target, { recursive: true });
      await mkdir(native, { recursive: true });
      const rollout = join(native, `rollout-2026-10-11T12-00-00-${vendorResumeId}.jsonl`);
      await writeFile(join(native, 'a-unrelated.jsonl'), '{}\n');
      await writeFile(rollout, '{}\n');
      await symlink(native, join(target, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
      // Genuine OS read observation proves the hinted fast path is consumed through the real catalog.
      const opens = vi.spyOn(fileSystem, 'open');
      syncBuiltinESMExports();
      try {
        await expect(canResumeFromMaterializedState({
          agentId: 'codex', serviceId: 'openai-codex', targetMaterializedRoot: target,
          requestedStateMode: 'shared', effectiveStateMode: 'shared',
          materializationIdentity: { v: 1, id: 'csm_target' }, vendorResumeId, cwd: '/tmp/project',
          candidatePersistedSessionFile: rollout,
        })).resolves.toMatchObject({ ok: true, resolvedPath: rollout });
        expect(opens.mock.calls.map(([path]) => path)).toEqual([rollout]);
      } finally { opens.mockRestore(); syncBuiltinESMExports(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns persisted_file provenance when candidatePersistedSessionFile exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-persisted-'));
    try {
      const candidate = join(root, 'sessions', '--tmp-project--', '2026-05-27T00-00-00-000Z_pi-session-1.jsonl');
      await mkdir(join(root, 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(candidate, '{}\n');

      await expect(canResumeFromMaterializedState({
        agentId: 'pi',
        serviceId: 'openai-codex',
        targetMaterializedRoot: root,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        materializationIdentity: { v: 1, id: 'csm_1' },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
      })).resolves.toMatchObject({
        ok: true,
        resolvedPath: candidate,
        source: 'persisted_file',
        effectiveStateMode: 'shared',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not treat a stale persisted candidate as continuity proof for a different vendor resume id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-stale-candidate-'));
    try {
      const staleCandidate = join(root, 'pi-agent-dir', 'sessions', '--tmp-project--', '2026-05-27T00-00-00-000Z_pi-session-B.jsonl');
      await mkdir(join(root, 'pi-agent-dir', 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(staleCandidate, '{}\n');

      const resume = resolveTrackedConnectedServiceSwitchContinuityContext({
        agentId: 'pi',
        baseDir: root,
        tracked: { vendorResumeId: 'pi-session-A' },
        vendorResumeId: 'pi-session-B',
        candidatePersistedSessionFile: staleCandidate,
      });
      expect(resume).toMatchObject({ vendorResumeId: 'pi-session-A', candidatePersistedSessionFile: null });

      await expect(canResumeFromMaterializedState({
        agentId: 'pi',
        serviceId: 'openai-codex',
        targetMaterializedRoot: root,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        materializationIdentity: { v: 1, id: 'csm_1' },
        vendorResumeId: resume.vendorResumeId ?? '',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: resume.candidatePersistedSessionFile,
      })).resolves.toMatchObject({
        ok: false,
        reason: 'pi_session_file_not_found',
        continuityDiagnostics: {
          vendorResumeId: 'pi-session-A',
          candidatePersistedSessionFile: null,
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('validates manifest session-file mappings against the filesystem', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-manifest-'));
    try {
      const mapped = join(root, 'sessions', '--tmp-project--', '2026-05-27T00-00-00-000Z_pi-session-1.jsonl');
      await mkdir(join(root, 'sessions', '--tmp-project--'), { recursive: true });
      await writeFile(mapped, '{}\n');

      await expect(canResumeFromMaterializedState({
        agentId: 'pi',
        serviceId: 'openai-codex',
        targetMaterializedRoot: root,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        materializationIdentity: { v: 1, id: 'csm_1' },
        vendorResumeId: 'pi-session-1',
        cwd: '/tmp/project',
        manifest: {
          v: 1,
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          lastSyncAtMs: Date.now(),
          configEntries: [],
          stateEntries: [],
          diagnostics: [],
          sessionFileMappings: [{
            vendorResumeId: 'pi-session-1',
            sourcePath: null,
            destinationPath: mapped,
            importedAtMs: Date.now(),
            verifiedAtMs: null,
          }],
        },
      })).resolves.toMatchObject({
        ok: true,
        resolvedPath: mapped,
        source: 'manifest_cache_validated',
        effectiveStateMode: 'shared',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed with provider-specific reason when session state is unsupported', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-not-implemented-'));
    try {
      await expect(canResumeFromMaterializedState({
        agentId: 'opencode',
        serviceId: 'openai',
        targetMaterializedRoot: root,
        requestedStateMode: 'shared',
        effectiveStateMode: 'shared',
        materializationIdentity: { v: 1, id: 'csm_1' },
        vendorResumeId: 'oc-session-1',
        cwd: '/tmp/project',
      })).resolves.toMatchObject({
        ok: false,
        reason: 'reachability_check_not_implemented',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns self-classifying continuity diagnostics when provider reachability misses the resume file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-can-resume-diagnostics-'));
    try {
      const candidate = join(root, 'native-source', 'missing-session.jsonl');

      await expect(canResumeFromMaterializedState({
        agentId: 'pi',
        serviceId: 'openai-codex',
        targetMaterializedRoot: root,
        requestedStateMode: 'isolated',
        effectiveStateMode: 'isolated',
        materializationIdentity: { v: 1, id: 'csm_pi_shared' },
        vendorResumeId: '019e7327-46cc-7dca-bb14-8473727db321',
        cwd: '/tmp/project',
        candidatePersistedSessionFile: candidate,
        manifest: {
          v: 1,
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          lastSyncAtMs: Date.now(),
          configEntries: [],
          stateEntries: ['sessions/--tmp-project--'],
          diagnostics: [],
          sessionFileMappings: [],
        },
      })).resolves.toMatchObject({
        ok: false,
        reason: 'pi_session_file_not_found',
        continuityDiagnostics: {
          materializationIdentityId: 'csm_pi_shared',
          targetMaterializedRoot: root,
          vendorResumeId: '019e7327-46cc-7dca-bb14-8473727db321',
          cwd: '/tmp/project',
          candidatePersistedSessionFile: candidate,
          requestedStateMode: 'shared',
          effectiveStateMode: 'shared',
          reachabilityMissReason: 'pi_session_file_not_found',
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
