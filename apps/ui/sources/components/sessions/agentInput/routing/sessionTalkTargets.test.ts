import { describe, expect, it } from 'vitest';

import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { Session } from '@/sync/domains/state/storageTypes';

import { readSessionTalkTargets } from './sessionTalkTargets';

function session(
  id: string,
  name: string,
  lead: string | null,
  serverId = 'home-a',
  createdAt = 0,
): Session {
  return createSessionFixture({
    id,
    serverId,
    createdAt,
    metadata: { path: '/repo', host: 'host', name },
    manager: lead ? { sessionId: lead } : null,
  });
}

describe('readSessionTalkTargets (who manager / workers / siblings name now)', () => {
  const sessions = {
    lead: session('lead', 'Payments v2 rollout', null),
    api: session('api', 'Idempotent retries', 'lead', 'home-a', 2),
    ui: session('ui', 'Checkout UI retry states', 'lead', 'home-a', 1),
    doc: session('doc', 'Support runbook for retries', 'lead', 'home-a', 3),
    ledger: session('ledger', 'Backfill intent ledger', 'api'),
    grandchild: session('grandchild', 'Ledger shard 2', 'ledger'),
    elsewhere: session(
      'elsewhere',
      'Same lead id on another Home',
      'lead',
      'home-b',
    ),
  };

  it('names the lead, the direct workers and the siblings without this session, oldest first', () => {
    expect(readSessionTalkTargets(sessions, 'api', 'home-a')).toEqual({
      manager: 'Payments v2 rollout',
      workers: ['Backfill intent ledger'],
      siblings: ['Checkout UI retry states', 'Support runbook for retries'],
    });
  });

  it('has no manager or siblings for a top-level session, and only direct workers', () => {
    expect(readSessionTalkTargets(sessions, 'lead', 'home-a')).toEqual({
      manager: null,
      workers: [
        'Checkout UI retry states',
        'Idempotent retries',
        'Support runbook for retries',
      ],
      siblings: [],
    });
  });
});
