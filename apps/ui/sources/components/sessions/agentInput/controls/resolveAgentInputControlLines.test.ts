import { describe, expect, it } from 'vitest';

import { resolveAgentInputControlLines } from './resolveAgentInputControlLines';

describe('resolveAgentInputControlLines', () => {
    it('reads rail 1 as setup and rail 2 as location (owner 2026-10-12)', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'scroll',
            controlIds: ['workflow', 'capabilities', 'checkout', 'automation', 'env', 'profile', 'connectedServices', 'mode',
                'permission', 'engine', 'files', 'attachments', 'resume', 'path', 'machine', 'organization', 'tags', 'sessionAccess'],
        });

        expect(lines.primary).toEqual(['attachments', 'files', 'engine', 'permission', 'mode', 'connectedServices',
            'profile', 'env', 'workflow', 'capabilities', 'sessionAccess', 'tags']);
        expect(lines.secondary).toEqual(['machine', 'path', 'resume', 'checkout', 'organization', 'automation']);
    });

    it('preserves Session access independently from recipient routing in the composer and overflow', () => {
        const controlIds = ['recipient', 'sessionAccess'] as const;
        expect(resolveAgentInputControlLines({ layout: 'wrap', controlIds }).primary)
            .toEqual(['sessionAccess', 'recipient']);
        expect(resolveAgentInputControlLines({ layout: 'collapsed', controlIds }).collapsed)
            .toEqual(['sessionAccess', 'recipient']);
    });
    it('keeps primary and secondary controls on separate lines in wrap layout', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume'],
        });

        expect(lines.primary).toEqual(['files', 'engine', 'permission', 'stop', 'reviewComments']);
        expect(lines.secondary).toEqual(['machine', 'path', 'resume']);
        expect(lines.collapsed).toEqual([]);
    });

    it('keeps primary and secondary controls on separate lines in scroll layout', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'scroll',
            controlIds: ['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume'],
        });

        expect(lines.primary).toEqual(['files', 'engine', 'permission', 'stop', 'reviewComments']);
        expect(lines.secondary).toEqual(['machine', 'path', 'resume']);
        expect(lines.collapsed).toEqual([]);
    });

    it('moves all controls into the collapsed action menu in collapsed layout', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'collapsed',
            controlIds: ['engine', 'permission', 'stop', 'files', 'reviewComments', 'machine', 'path', 'resume'],
        });

        expect(lines.primary).toEqual([]);
        expect(lines.secondary).toEqual([]);
        expect(lines.collapsed).toEqual(['files', 'engine', 'permission', 'stop', 'reviewComments', 'machine', 'path', 'resume']);
    });

    it('keeps connected services on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'connectedServices', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'connectedServices']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps storage on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'storage', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'storage']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps linked files on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'linkedFiles', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['linkedFiles', 'engine']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps shortcuts on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'shortcuts', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'shortcuts']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('keeps capabilities on the primary line ahead of secondary machine/path controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'capabilities', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine', 'capabilities']);
        expect(lines.secondary).toEqual(['machine', 'path']);
    });

    it('puts automation on the location rail after machine and folder', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['engine', 'automation', 'machine', 'path'],
        });

        expect(lines.primary).toEqual(['engine']);
        expect(lines.secondary).toEqual(['machine', 'path', 'automation']);
    });

    it('keeps admitted plugin controls in supplied normalized contribution order after host controls', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'wrap',
            controlIds: ['plugin:fixture/second', 'engine', 'plugin:fixture/first', 'machine'],
        });

        expect(lines.primary).toEqual([
            'engine',
            'plugin:fixture/second',
            'plugin:fixture/first',
        ]);
        expect(lines.secondary).toEqual(['machine']);
        expect(lines.collapsed).toEqual([]);
    });

    it('keeps admitted plugin controls in the same canonical order when collapsed into overflow', () => {
        const lines = resolveAgentInputControlLines({
            layout: 'collapsed',
            controlIds: ['plugin:fixture/second', 'engine', 'plugin:fixture/first', 'machine'],
        });

        expect(lines.primary).toEqual([]);
        expect(lines.secondary).toEqual([]);
        expect(lines.collapsed).toEqual([
            'engine',
            'machine',
            'plugin:fixture/second',
            'plugin:fixture/first',
        ]);
    });

    it('keeps stop pinned in the early primary order defined by the canonical registry', () => {
        const lines = resolveAgentInputControlLines({ layout: 'collapsed', controlIds: [
            'path', 'workflowTargets', 'sessionAccess', 'stop', 'workflowInputs', 'machine', 'automation', 'workflowRoles', 'workflow',
        ] });
        expect(lines.collapsed).toEqual([
            'stop', 'workflow', 'workflowInputs', 'workflowRoles', 'workflowTargets', 'sessionAccess', 'machine', 'path', 'automation',
        ]);
    });
});
