import { describe, expect, it } from 'vitest';
import { listActionSpecs } from '../actions/actionSpecs.js';
import {
  isHappierToolAutoApprovedByAgentLayerV1,
  listHappierToolAutoApprovedNamesV1,
  listHappierToolAutoApprovedNameSpellingsV1,
} from './happierToolAutoApprovalV1.js';

describe('Happier tool Agent-layer auto-approval', () => {
  it('derives direct tools from current Action safety while Action approval retains custody', () => {
    for (const spec of listActionSpecs()) {
      const name = spec.bindings?.mcpToolName;
      if (!name) continue;
      expect(isHappierToolAutoApprovedByAgentLayerV1(name), spec.id).toBe(spec.safety === 'safe');
    }
    expect(listHappierToolAutoApprovedNamesV1()).toContain('action_execute');
    expect(listHappierToolAutoApprovedNamesV1()).toContain('action_spec_search');
    expect(listHappierToolAutoApprovedNamesV1()).toContain('action_spec_get');
    expect(listHappierToolAutoApprovedNamesV1()).toContain('action_options_resolve');
  });

  it.each([
    ['session_title_set', true],
    ['change-title', true],
    ['change title', true],
    ['mcp__happier__session-title-set', true],
    ['mcp__happier__execution_run_get', true],
    ['happy_action_execute', true],
    ['happier__action_spec_get', true],
    ['mcp__happy__session_title_set', true],
    ['mcp__other__session_title_set', false],
    ['mcp__happier__daemon_filesystem_delete', false],
    ['happier_action_execute_extra', false],
    ['think', false],
    ['', false],
  ])('recognizes exact spellings for %s', (name, allowed) => {
    expect(isHappierToolAutoApprovedByAgentLayerV1(name)).toBe(allowed);
  });

  it('projects one native spelling per safe tool while host recognition retains its aliases', () => {
    for (const prefix of ['happier_', 'mcp__happier__', '']) {
      const spellings = listHappierToolAutoApprovedNameSpellingsV1(prefix);
      expect(spellings).toEqual(listHappierToolAutoApprovedNamesV1().map((name) => `${prefix}${name}`));
      for (const name of spellings) expect(isHappierToolAutoApprovedByAgentLayerV1(name)).toBe(true);
    }
    expect(listHappierToolAutoApprovedNameSpellingsV1('happier_')).not.toContain('change-title');
    expect(isHappierToolAutoApprovedByAgentLayerV1(' MCP__HAPPIER__ACTION_EXECUTE ')).toBe(true);
  });
});
