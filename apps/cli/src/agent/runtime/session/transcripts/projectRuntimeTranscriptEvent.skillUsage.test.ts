import { describe, expect, it, vi } from 'vitest';
import type { AgentSessionSkillDelivery } from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/protocol/runtime/agentSessionV1';
import { configuration } from '@/configuration';
import { projectRuntimeTranscriptEvent } from './projectRuntimeTranscriptEvent';

// Daemon HTTP is outside the runner process; identity and projection stay real.
const boundary = vi.hoisted(() => ({ requests: [] as unknown[], fail: false }));
vi.mock('@/daemon/controlClient', () => ({
  recordDaemonSkillUse: async (request: unknown) => {
    boundary.requests.push(request);
    if (boundary.fail) throw new Error('daemon unavailable');
  },
}));

const digest = `sha256:${'a'.repeat(64)}`;
const usageAccount = { accountId: 'account', serverHttpBaseUrl: 'https://home.example.test' };
const skillDelivery: AgentSessionSkillDelivery = {
  pluginRoot: '/private/session', skillsRoot: '/private/session/skills', nativeDisables: [],
  items: [{ skillId: 'library:review', name: 'review', digest, directory: '/private/session/skills/review' }],
};
const evidence = (skills: readonly { name: string; path?: string }[], sessionId = 'session') =>
  AgentSessionRuntimeEventSchema.parse({ kind: 'skill-usage', sequence: 1, sessionId, turnId: 'turn', emittedAtMs: 100, skills });

describe('skill-use runtime projection', () => {
  it('records one library identity from session and cache evidence without writing a transcript', async () => {
    boundary.requests = []; boundary.fail = false;
    const enqueueAgentMessageCommitted = vi.fn();
    const result = await projectRuntimeTranscriptEvent({ session: { sessionId: 'session', enqueueAgentMessageCommitted },
      skillDelivery, usageAccount, event: evidence([{ name: 'happier:review' }, { name: 'review',
        path: `${configuration.happyHomeDir}/skills/cache/${digest.slice(7)}/SKILL.md` }]) });
    expect(result).toEqual({ projected: true, kind: 'skill-usage' });
    expect(boundary.requests).toEqual([{ skillIds: ['library:review'], account: usageAccount }]);
    expect(enqueueAgentMessageCommitted).not.toHaveBeenCalled();
  });

  it('rejects native paths, unknown names, retired delivery and another session', async () => {
    boundary.requests = []; boundary.fail = false;
    await projectRuntimeTranscriptEvent({ session: { sessionId: 'session' }, skillDelivery, usageAccount,
      event: evidence([{ name: 'review', path: '/native/skills/review/SKILL.md' }, { name: 'unknown' }]) });
    await projectRuntimeTranscriptEvent({ session: { sessionId: 'session' }, event: evidence([{ name: 'happier:review' }]) });
    await projectRuntimeTranscriptEvent({ session: { sessionId: 'session' }, skillDelivery, usageAccount,
      event: evidence([{ name: 'happier:review' }], 'other') });
    expect(boundary.requests).toEqual([]);
  });

  it('records nothing without the source Account binding even with matching delivered evidence', async () => {
    boundary.requests = []; boundary.fail = false;
    await projectRuntimeTranscriptEvent({ session: { sessionId: 'session' }, skillDelivery,
      event: evidence([{ name: 'happier:review' }]) });
    expect(boundary.requests).toEqual([]);
  });

  it('does not turn optional usage transport failure into a transcript failure', async () => {
    boundary.requests = []; boundary.fail = true;
    await expect(projectRuntimeTranscriptEvent({ session: { sessionId: 'session' }, skillDelivery, usageAccount,
      event: evidence([{ name: 'happier:review' }]) })).resolves.toEqual({ projected: false, reason: 'unsupported_event' });
    expect(boundary.requests).toEqual([{ skillIds: ['library:review'], account: usageAccount }]);
    boundary.fail = false;
  });
});
