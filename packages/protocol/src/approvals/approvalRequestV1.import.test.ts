import { describe, expect, it } from 'vitest';
import { getActionSpec } from '../actions/actionSpecs.js';
import { ApprovalRequestV2Schema } from './approvalRequestV1.js';
import { PLUGIN_INVOCABLE_ACTION_IDS } from '../actions/pluginActionSurface.js';

describe('approval Protocol cold initialization', () => {
  it('loads approval schemas and plugin surfaces through a fresh Action catalog import', () => {
    expect(ApprovalRequestV2Schema.safeParse({}).success).toBe(false);
    expect(getActionSpec('approval.request.decide').id).toBe('approval.request.decide');
    expect(PLUGIN_INVOCABLE_ACTION_IDS).toContain('session.message.send');
  });
});
