import { describe, expect, it } from 'vitest';
import { decodeAutomationTemplate, encodeAutomationTemplate } from './automationTemplatePayloadV1.js';

describe('Automation capability selection carrier', () => {
  it('folds predecessor MCP selection at stored ingress while tolerating additive fields', () => {
    // ../0.2 cd2bb4d853 sessionAuthoring/fieldCatalog.ts:368 and Automation TemplateSchema.
    const mcpSelection = { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['tools'], forceExcludeServerIds: [] };
    const read = decodeAutomationTemplate(JSON.stringify({ directory: '/repo', mcpSelection, future: true }));
    expect(read).toMatchObject({ capabilitySelection: { mcp: mcpSelection } });
    expect(read).not.toHaveProperty('mcpSelection');
    expect(read).not.toHaveProperty('future');
  });
  it('writes and restores both kinds using only the current carrier', () => {
    const capabilitySelection = { skills: { v: 1 as const, forceIncludeSkillIds: ['lint'],
      forceExcludeSkillIds: ['review'], excludeNativeSkillNames: ['native'] } };
    const encoded = encodeAutomationTemplate({ directory: '/repo', capabilitySelection });
    expect(decodeAutomationTemplate(encoded)).toMatchObject({ capabilitySelection });
    expect(JSON.parse(encoded)).not.toHaveProperty('mcpSelection');
  });
  it('refuses malformed selection presence instead of reviving the legacy selection', () => {
    const legacy = { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['tools'], forceExcludeServerIds: [] };
    expect(decodeAutomationTemplate(JSON.stringify({ directory: '/repo', mcpSelection: legacy,
      capabilitySelection: { skills: { v: 2 } } }))).toBeNull();
    expect(decodeAutomationTemplate(JSON.stringify({ directory: '/repo', mcpSelection: { v: 2 } }))).toBeNull();
  });
});
