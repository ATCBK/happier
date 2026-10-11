import { describe, expect, it } from 'vitest';

import { scenarioCatalog } from '../../src/testkit/providers/scenarios/scenarioCatalog';
import { checkMaxTraceEvents } from '../../src/testkit/providers/satisfaction/traceSatisfaction';
import type { ProviderTraceEvent, ProviderUnderTest } from '../../src/testkit/providers/types';

function provider(id: string): ProviderUnderTest {
  return {
    id, enableEnvVar: `HAPPIER_E2E_PROVIDER_${id.toUpperCase()}`, protocol: 'acp', traceProvider: id,
    scenarioRegistry: { v: 1, tiers: { smoke: [], extended: [] } }, cli: { subcommand: id },
  };
}

describe('scenarioCatalog: MCP title change', () => {
  it('permits deferred tool discovery before the title action while retaining ordinary cardinality', () => {
    const events: ProviderTraceEvent[] = [
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'codebuddy', kind: 'tool-call', payload: { callId: 'search', name: 'ToolSearch' } },
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'codebuddy', kind: 'tool-result', payload: { callId: 'search' } },
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'codebuddy', kind: 'tool-call', payload: { callId: 'title', name: 'change_title' } },
      { v: 1, sessionId: 's1', protocol: 'acp', provider: 'codebuddy', kind: 'tool-result', payload: { callId: 'title' } },
    ];
    for (const id of ['codebuddy', 'grok']) {
      const limits = scenarioCatalog.mcp_change_title(provider(id)).maxTraceEvents;
      if (!limits) throw new Error('MCP title scenario has no cardinality contract');
      expect(checkMaxTraceEvents(events, limits)).toEqual({ ok: true });
    }
    const ordinaryLimits = scenarioCatalog.mcp_change_title(provider('opencode')).maxTraceEvents;
    if (!ordinaryLimits) throw new Error('MCP title scenario has no cardinality contract');
    expect(checkMaxTraceEvents(events, ordinaryLimits).ok).toBe(false);
  });
});
