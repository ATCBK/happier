import { describe, expect, it } from 'vitest';

import { buildAgentInstallChangeConfirm } from './agentInstallChangeConfirm';

describe('buildAgentInstallChangeConfirm', () => {
  it('names the machines installing now and those installing on first use, and where it downloads from', () => {
    const body = buildAgentInstallChangeConfirm({
      name: 'goose',
      version: '1.54.0',
      nowMachines: ['MacBook Pro', 'nl2'],
      firstUseMachines: ['Windows desktop'],
      sourceHost: 'github.com',
    });
    const text = body.paragraphs.map((paragraph) => paragraph.text).join('\n');
    expect(body.title).toContain('goose');
    expect(body.title).toContain('1.54.0');
    expect(body.paragraphs).toHaveLength(3);
    expect(text).toContain('MacBook Pro');
    expect(text).toContain('nl2');
    expect(text).toContain('Windows desktop');
    expect(text).toContain('github.com');
  });

  it('states the vendor installer only when the request carries that consent, so approving it is the consent', () => {
    const base = {
      name: 'Cursor',
      version: '1.0.0',
      nowMachines: ['nl2'],
      firstUseMachines: [],
    };
    const without = buildAgentInstallChangeConfirm(base);
    const withRecipe = buildAgentInstallChangeConfirm({
      ...base,
      vendorRecipe: true,
    });
    expect(withRecipe.paragraphs).toHaveLength(without.paragraphs.length + 1);
  });
});
