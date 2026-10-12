import { describe, expect, it } from 'vitest';
import {
    readAppliedSessionCapabilitySelectionFromMetadataV1,
    readPendingCapabilityApplyV1,
    readSessionCapabilitySelectionFromMetadataV1,
    resolveSelectionRestartMarkersForStartupV1,
    writeSessionCapabilitySelectionToMetadataV1,
} from './sessionCapabilityMetadataV1.js';

const mcp = { v: 1 as const, managedServersEnabled: true, forceIncludeServerIds: [], forceExcludeServerIds: [] };
const skills = { v: 1 as const, forceIncludeSkillIds: [], forceExcludeSkillIds: [], excludeNativeSkillNames: [] };
const next = { mcp: { ...mcp, forceIncludeServerIds: ['linear'] }, skills: { ...skills, forceIncludeSkillIds: ['lint'] } };

describe('session capability metadata codec', () => {
    it('reads the predecessor MCP metadata shape and round-trips its released keys', () => {
        // ../0.2 at cd2bb4d853: mcpServers/sessionSelectionV1.ts and UI sessionMcpSelectionPublish.ts.
        const previous = { path: '/project', mcpSelectionV1: mcp };
        expect(readSessionCapabilitySelectionFromMetadataV1(previous)).toEqual({ mcp, skills });
        expect(writeSessionCapabilitySelectionToMetadataV1(previous, { mcp }, { sessionActive: false })).toEqual(previous);
        expect(readSessionCapabilitySelectionFromMetadataV1({ mcpSelectionV1: { ...mcp, futureField: true } })).toEqual({ mcp, skills });
    });

    it('keeps the initially applied policy across several active changes and clears reverted changes', () => {
        const previous = { path: '/project', mcpSelectionV1: mcp, skillSelectionV1: skills };
        const changed = writeSessionCapabilitySelectionToMetadataV1(previous, next, { sessionActive: true });
        expect(changed).toMatchObject({
            mcpSelectionV1: next.mcp, skillSelectionV1: next.skills,
            mcpSelectionRestartRequiredV1: { v: 1, appliedSelection: mcp },
            skillSelectionRestartRequiredV1: { v: 1, appliedSelection: skills },
        });
        const changedAgain = writeSessionCapabilitySelectionToMetadataV1(changed, {
            skills: { ...skills, forceIncludeSkillIds: ['review'] },
        }, { sessionActive: true });
        expect(changedAgain).toMatchObject({ skillSelectionRestartRequiredV1: { v: 1, appliedSelection: skills } });
        expect(readAppliedSessionCapabilitySelectionFromMetadataV1(changedAgain)).toEqual({ mcp, skills });
        expect(readPendingCapabilityApplyV1(changedAgain)).toEqual({ mcp: true, skills: true });
        const reverted = writeSessionCapabilitySelectionToMetadataV1(changedAgain, { mcp, skills }, { sessionActive: true });
        expect(readPendingCapabilityApplyV1(reverted)).toEqual({ mcp: false, skills: false });
        expect(reverted).not.toHaveProperty('mcpSelectionRestartRequiredV1');
        expect(reverted).not.toHaveProperty('skillSelectionRestartRequiredV1');
    });

    it('preserves pending markers for a preserved process and clears only positively applied kinds', () => {
        const pending = writeSessionCapabilitySelectionToMetadataV1({ path: '/project' }, next, { sessionActive: true });
        expect(resolveSelectionRestartMarkersForStartupV1({ current: pending, applied: 'preserved_process' })).toEqual(pending);
        const onlyMcpApplied = resolveSelectionRestartMarkersForStartupV1({ current: pending, applied: { mcp: next.mcp } });
        expect(onlyMcpApplied).not.toHaveProperty('mcpSelectionRestartRequiredV1');
        expect(onlyMcpApplied).toHaveProperty('skillSelectionRestartRequiredV1');
        expect(resolveSelectionRestartMarkersForStartupV1({ current: pending, applied: { mcp, skills } })).toEqual(pending);
        const applied = resolveSelectionRestartMarkersForStartupV1({ current: pending, applied: next });
        expect(readPendingCapabilityApplyV1(applied)).toEqual({ mcp: false, skills: false });
    });

    it('changes only the requested kind and writes no restart marker for a stopped session', () => {
        const pending = writeSessionCapabilitySelectionToMetadataV1({ path: '/project', custom: { keep: true } }, next, { sessionActive: true });
        const updated = writeSessionCapabilitySelectionToMetadataV1(pending, { skills }, { sessionActive: false });
        expect(updated).toMatchObject({ path: '/project', custom: { keep: true }, mcpSelectionV1: next.mcp, skillSelectionV1: skills });
        expect(updated).toHaveProperty('mcpSelectionRestartRequiredV1');
        expect(updated).not.toHaveProperty('skillSelectionRestartRequiredV1');
    });

    it('records the captured startup baseline when desired selection advanced before acknowledgement', () => {
        const captured = {
            mcp: { ...mcp, forceIncludeServerIds: ['captured-server'] },
            skills: { ...skills, forceIncludeSkillIds: ['captured-skill'] },
        };
        for (const sessionActive of [true, false]) {
            const current = writeSessionCapabilitySelectionToMetadataV1({ path: '/project', mcpSelectionV1: mcp, skillSelectionV1: skills },
                next, { sessionActive });
            const resumed = resolveSelectionRestartMarkersForStartupV1({ current, applied: captured });
            expect(readSessionCapabilitySelectionFromMetadataV1(resumed)).toEqual(next);
            expect(readAppliedSessionCapabilitySelectionFromMetadataV1(resumed)).toEqual(captured);
            expect(readPendingCapabilityApplyV1(resumed)).toEqual({ mcp: true, skills: true });
            const changedBack = writeSessionCapabilitySelectionToMetadataV1(resumed, { mcp, skills }, { sessionActive: true });
            expect(readPendingCapabilityApplyV1(changedBack)).toEqual({ mcp: true, skills: true });
        }
    });
});
