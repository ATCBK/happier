import { describe, expect, it } from 'vitest';
import { actionSpecToActionDefinitionV1 } from './actionCatalog.js';
import { getActionSpec, listActionSpecs } from './actionSpecs.js';
import { projectActionSpecSchemaSections } from './actionSpecSections.js';

describe('Action schema sections', () => {
  it('retrieves nested contributed definitions and escaped names without losing schema metadata', () => {
    const base = actionSpecToActionDefinitionV1(getActionSpec('action.spec.get'), { includeOutputSchema: false });
    const nested = { type: 'string', minLength: 1 };
    const definition = { ...base, inputSchema: { type: 'object', $comment: 'Author metadata', definitions: {
      'outer/name': { type: 'object', definitions: { 'inner~name': nested } },
    } } };
    const root = projectActionSpecSchemaSections(definition);
    expect(root.actionSpec.inputSchema.$comment).toBe('Author metadata');
    const outer = projectActionSpecSchemaSections(definition, root.schemaSections[0].path);
    const inner = projectActionSpecSchemaSections(definition, outer.schemaSections[0].path);
    expect(inner.schemaSection?.schema).toEqual(nested);
  });

  it('keeps every widget, Board and Home discovery response below Claude\'s documented foreground character boundary', () => {
    const rows = listActionSpecs().filter(spec => /^(widgets\.|boards\.|session\.board\.|home\.hub\.layout\.)/.test(spec.id)).map(spec => {
      const full = actionSpecToActionDefinitionV1(spec, { surface: 'mcp', includeOutputSchema: true });
      const projected = projectActionSpecSchemaSections(full);
      const sectionSizes = projected.schemaSections.map(section => JSON.stringify(projectActionSpecSchemaSections(full, section.path)).length);
      const size = JSON.stringify(projected).length;
      expect(size, spec.id).toBeLessThan(50000);
      for (const sectionSize of sectionSizes) expect(sectionSize, spec.id).toBeLessThan(50000);
      return { id: spec.id, size, largestSection: Math.max(0, ...sectionSizes) };
    });
    console.info(JSON.stringify({ census: rows }));
  });

  it('retrieves the complete Board grammar as named sections without changing the full schema', () => {
    const spec = actionSpecToActionDefinitionV1(getActionSpec('session.board.item.upsert'), { surface: 'mcp', includeOutputSchema: false });
    const original = JSON.stringify(spec);
    const result = projectActionSpecSchemaSections(spec);
    expect(JSON.stringify(result).length).toBeLessThan(50000);
    expect(result.schemaSections.length).toBeGreaterThan(0);
    const definitions: Record<string, unknown> = {};
    for (const section of result.schemaSections) {
      const read = projectActionSpecSchemaSections(spec, section.path);
      expect(read).toHaveProperty('schemaSection');
      if (!('schemaSection' in read)) throw new Error('Missing section');
      expect(JSON.stringify(read).length).toBeLessThan(50000);
      definitions[section.path.split('/').at(-1)!] = read.schemaSection.schema;
    }
    expect({ ...result.actionSpec.inputSchema, definitions }).toEqual(spec.inputSchema);
    expect(JSON.stringify(spec)).toBe(original);
    expect(() => projectActionSpecSchemaSections(spec, '/inputSchema/__proto__')).toThrow();
    expect(() => projectActionSpecSchemaSections(spec, '/inputSchema/definitions')).toThrow();
  });
});
