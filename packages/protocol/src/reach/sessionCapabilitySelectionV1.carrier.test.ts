import { describe, expect, it } from 'vitest';
import { readCapabilitySelectionCarrierV1, SessionCapabilitySelectionAuthoringV1Schema, SessionCapabilitySelectionV1Schema } from './sessionCapabilitySelectionV1.js';

const mcp = { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: ['linear'], forceExcludeServerIds: [] };
const skills = { v: 1 as const, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] };

describe('capability selection carrier ingress', () => {
    it('folds only the released MCP carrier and preserves both kinds of the current carrier', () => {
        expect(readCapabilitySelectionCarrierV1({ mcpSelection: mcp, anotherField: true })).toEqual({ mcp });
        expect(readCapabilitySelectionCarrierV1({ capabilitySelection: { mcp, skills }, mcpSelection: { ...mcp, managedServersEnabled: false } })).toEqual({ mcp, skills });
        expect(readCapabilitySelectionCarrierV1({})).toBeNull();
        expect(readCapabilitySelectionCarrierV1({ capabilitySelection: null, mcpSelection: null })).toBeNull();
    });

    it('does not downgrade a malformed current carrier to a valid legacy one', () => {
        expect(readCapabilitySelectionCarrierV1({ capabilitySelection: { skills: { v: 2 } }, mcpSelection: mcp })).toBeNull();
        for (const malformed of ['invalid', null, []]) {
            expect(readCapabilitySelectionCarrierV1({ capabilitySelection: { mcp: malformed }, mcpSelection: mcp })).toBeNull();
        }
        expect(readCapabilitySelectionCarrierV1({ mcpSelection: { v: 2 } })).toBeNull();
    });

    it('keeps authoring strict and stored selection reads tolerant, including nested kinds', () => {
        const stored = { futureKind: true, mcp: { ...mcp, futureField: true }, skills: { ...skills, futureField: true } };
        expect(SessionCapabilitySelectionAuthoringV1Schema.safeParse(stored).success).toBe(false);
        expect(SessionCapabilitySelectionV1Schema.parse(stored)).toEqual({ mcp, skills });
        expect(readCapabilitySelectionCarrierV1({ capabilitySelection: stored })).toEqual({ mcp, skills });
    });
});
