import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionControlContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentRuntimeDiagnosticDataV1Schema } from '@happier-dev/protocol/runtime/agentRuntimeDiagnosticV1';

import { withCodexNativeAttachFixture } from './appServer/runtime.nativeAttach.test-support.js';
import { createCodexNativeSessionControls } from './controls.js';

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
