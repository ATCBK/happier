import { describe, expect, it } from 'vitest';

import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { mergeSessionMetadataForStartup } from './mergeSessionMetadataForStartup';

const appliedMcp = { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] };
const desiredMcp = { ...appliedMcp, forceIncludeServerIds: ['server-new'] };
const appliedSkills = { v: 1 as const, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: [] };
const desiredSkills = { ...appliedSkills, forceIncludeSkillIds: ['skill-new'], excludeNativeSkillNames: ['native-skill'] };

function pendingMetadata() {
    return {
        ...createTestMetadata(),
        mcpSelectionV1: desiredMcp,
        mcpSelectionRestartRequiredV1: { v: 1 as const, appliedSelection: appliedMcp },
        skillSelectionV1: desiredSkills,
        skillSelectionRestartRequiredV1: { v: 1 as const, appliedSelection: appliedSkills },
    };
}

describe('capability selection startup markers', () => {
    it('keeps both pending selections when attaching to a preserved Agent process', () => {
        const current = pendingMetadata();
        const merged = mergeSessionMetadataForStartup({ current, next: createTestMetadata(), mode: 'attach', nowMs: 100 });
        expect(merged).toMatchObject({
            mcpSelectionV1: desiredMcp,
            skillSelectionV1: desiredSkills,
            mcpSelectionRestartRequiredV1: current.mcpSelectionRestartRequiredV1,
            skillSelectionRestartRequiredV1: current.skillSelectionRestartRequiredV1,
        });
    });

    it('clears both markers when a new process starts with the desired selection', () => {
        const merged = mergeSessionMetadataForStartup({ current: pendingMetadata(), next: createTestMetadata(), mode: 'start', nowMs: 100 });
        expect(merged).toMatchObject({ mcpSelectionV1: desiredMcp, skillSelectionV1: desiredSkills });
        expect(merged).not.toHaveProperty('mcpSelectionRestartRequiredV1');
        expect(merged).not.toHaveProperty('skillSelectionRestartRequiredV1');
    });

    it('acknowledges a resumed process only for selections it actually captured', () => {
        const current = pendingMetadata();
        const merged = mergeSessionMetadataForStartup({ current, next: createTestMetadata(), mode: 'attach', nowMs: 100,
            appliedCapabilitySelection: { mcp: desiredMcp, skills: appliedSkills },
        });
        expect(merged).not.toHaveProperty('mcpSelectionRestartRequiredV1');
        expect(merged).toHaveProperty('skillSelectionRestartRequiredV1', current.skillSelectionRestartRequiredV1);
        expect(merged).toHaveProperty('skillSelectionV1', desiredSkills);
        const resumed = mergeSessionMetadataForStartup({ current, next: createTestMetadata(), mode: 'attach', nowMs: 100,
            appliedCapabilitySelection: { mcp: desiredMcp, skills: desiredSkills },
        });
        expect(resumed).not.toHaveProperty('mcpSelectionRestartRequiredV1');
        expect(resumed).not.toHaveProperty('skillSelectionRestartRequiredV1');
    });

    it('does not seed either selection from new-process defaults on a preserved attach', () => {
        const merged = mergeSessionMetadataForStartup({ current: createTestMetadata(), next: pendingMetadata(), mode: 'attach', nowMs: 100 });
        expect(merged).not.toHaveProperty('mcpSelectionV1');
        expect(merged).not.toHaveProperty('skillSelectionV1');
        expect(merged).not.toHaveProperty('mcpSelectionRestartRequiredV1');
        expect(merged).not.toHaveProperty('skillSelectionRestartRequiredV1');
    });
});
