import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlContext, AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeDiagnosticDataV1Schema } from '@happier-dev/protocol/runtime/agentRuntimeDiagnosticV1';

import { withCodexNativeAttachFixture } from './appServer/runtime.nativeAttach.test-support.js';
import { createCodexNativeSessionControls } from './controls.js';
import { createCodexAgentRuntime } from './engine.js';

describe('Codex delivered skill catalog context', () => {
  it('uses the live delivery root for fresh catalog clients, including external plugin skills and reloads', async () => {
    const skills: AgentSessionSkillDelivery = {
      pluginRoot: '/private/session-delivery', skillsRoot: '/private/session-delivery/skills',
      items: [
        { name: 'account-review', skillId: 'account-review', digest: 'sha256:account', directory: '/private/session-delivery/skills/account-source' },
        { name: 'external-review', skillId: 'plugin:acme.tools:review', digest: 'sha256:external', directory: '/private/session-delivery/skills/external-source' },
      ], nativeDisables: [],
    };
    const replacement = { ...skills, skillsRoot: '/private/session-reloaded/skills',
      items: skills.items.map(item => ({ ...item, directory: item.directory.replace('session-delivery', 'session-reloaded') })) };
    const engine = await createCodexAgentRuntime({
      plugin: { id: 'happier.agent.codex', version: '0.0.0' }, agent: { id: 'codex' }, signal: new AbortController().signal,
    });
    if (!engine.sessions?.catalog) throw new Error('Missing Codex Session catalog');
    const sessions = engine.sessions;
    const catalog = engine.sessions.catalog;
    const nativeBoundary = {
      skills, sessionFactory: sessions, rejectExtraRootsSet: false,
      skillListResponseForRoots: (roots: readonly string[]) => ({ data: [{ skills:
        [skills, replacement].filter(delivery => roots.includes(delivery.skillsRoot))
          .flatMap(delivery => delivery.items.map(item => ({ name: item.name, path: `${item.directory}/SKILL.md` }))),
      }] }),
    };
    await withCodexNativeAttachFixture(async fixture => {
      const session = await fixture.openConfiguredSession();
      const context = {
        signal: new AbortController().signal, services: { exec: fixture.exec, logger: { warn: vi.fn() } },
        session: { id: 'actual-happier-session', cwd: fixture.directory, activity: 'active', connectedAccounts: [] },
      } as unknown as AgentSessionControlContext;
      const expected = (delivery: AgentSessionSkillDelivery) => ({ status: 'ok', kind: 'skills',
        items: delivery.items.map(item => ({ name: item.name, path: `${item.directory}/SKILL.md` })) });
      expect(session.skillsDelivered).toBe(true);
      expect(await catalog.list({ kind: 'skills' }, context)).toMatchObject(expected(skills));
      await expect(session.refreshSkills?.({ skills: replacement }, { signal: AbortSignal.abort() })).rejects.toThrow();
      expect(await catalog.list({ kind: 'skills' }, context)).toMatchObject(expected(skills));
      expect(await session.refreshSkills?.({ skills: replacement })).toEqual({ kind: 'applied' });
      expect(await catalog.list({ kind: 'skills' }, context)).toMatchObject(expected(replacement));
      nativeBoundary.rejectExtraRootsSet = true;
      expect(await catalog.list({ kind: 'skills' }, context))
        .toMatchObject({ status: 'unavailable', diagnostic: { code: 'codex_catalog_startup_failed' } });
      expect(await catalog.list({ kind: 'vendorPlugins' }, context)).toMatchObject({ status: 'ok', kind: 'vendorPlugins' });
      nativeBoundary.rejectExtraRootsSet = false;
      // A separate Session and a disposed launch must not inherit this Session's root.
      expect(await catalog.list({ kind: 'skills' }, { ...context, session: { ...context.session, id: 'other-session' } }))
        .toMatchObject({ status: 'ok', kind: 'skills', items: [] });
      await session.dispose();
      expect(await catalog.list({ kind: 'skills' }, context)).toMatchObject({ status: 'ok', kind: 'skills', items: [] });
    }, nativeBoundary);
  });
});

describe('Codex native catalog failure evidence', () => {
  it.each(['startup', 'request'] as const)('retains a safe typed %s cause through the real client', async phase => {
    await withCodexNativeAttachFixture(async fixture => {
      const warn = vi.fn();
      // Only the OS/process boundary is replaced for the startup refusal.
      const exec = phase === 'startup'
        ? { ...fixture.exec, clients: { ...fixture.exec.clients, spawn: async () => {
          throw Object.assign(new Error('PRIVATE_TOKEN and private upstream body'), { code: 'ECONNRESET' });
        } } }
        : fixture.exec;
      const context = {
        signal: new AbortController().signal, services: { exec, logger: { warn } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'active', connectedAccounts: [] },
      } as unknown as AgentSessionControlContext;
      const result = await createCodexNativeSessionControls().catalog.list({ kind: 'skills' }, context);
      const details = phase === 'startup'
        ? { phase, errorClass: 'Error', errorCode: 'ECONNRESET', httpStatus: null }
        : { phase, errorClass: 'JsonRpcApplicationError', errorCode: '-32000', httpStatus: null };
      expect(result).toMatchObject({ status: 'unavailable', retryable: true,
        diagnostic: { code: `codex_catalog_${phase}_failed`, details } });
      expect(warn).toHaveBeenCalledWith('codex_catalog_read_failed', details);
      if (result.status !== 'ok') expect(AgentRuntimeDiagnosticDataV1Schema.safeParse(result.diagnostic).success).toBe(true);
      expect(JSON.stringify({ result, logs: warn.mock.calls })).not.toMatch(/PRIVATE_TOKEN|private upstream body/);
    }, { skillListFailure: { code: -32000, message: 'PRIVATE_TOKEN and private upstream body' } });
  });

  it('maps the native project catalog and keeps an absent method distinct from a failed read', async () => {
    await withCodexNativeAttachFixture(async fixture => {
      const context = {
        signal: new AbortController().signal, services: { exec: fixture.exec, logger: { warn: vi.fn() } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'active', connectedAccounts: [] },
      } as unknown as AgentSessionControlContext;
      expect(await createCodexNativeSessionControls().catalog.list({ kind: 'skills' }, context))
        .toMatchObject({ status: 'ok', kind: 'skills', items: [{ name: 'project-skill', path: '/project/.agents/skills/project-skill/SKILL.md' }] });
    }, { skillListResponse: { data: [{ skills: [{ name: 'project-skill', path: '/project/.agents/skills/project-skill/SKILL.md' }] }] } });
    await withCodexNativeAttachFixture(async fixture => {
      const context = {
        signal: new AbortController().signal, services: { exec: fixture.exec, logger: { warn: vi.fn() } },
        session: { id: 'session-1', cwd: fixture.directory, activity: 'active', connectedAccounts: [] },
      } as unknown as AgentSessionControlContext;
      expect(await createCodexNativeSessionControls().catalog.list({ kind: 'skills' }, context))
        .toMatchObject({ status: 'unsupported', diagnostic: { code: 'codex_skill_catalog_unsupported' } });
    }, { skillListFailure: { code: -32601, message: 'Method not found' } });
  });
});
