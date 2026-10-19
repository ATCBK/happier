import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { resolveRenderedAgentInputControls } from './resolveRenderedAgentInputControls';

describe('resolveRenderedAgentInputControls', () => {
    it('keeps only the contained controls on one rail and drops every other chip (a compact composer)', () => {
        const node = (key: string) => <React.Fragment key={key}>{key}</React.Fragment>;
        const keys = (nodes: readonly React.ReactNode[]) => nodes.map((chip) => (chip as React.ReactElement).key);
        for (const layout of ['scroll', 'wrap', 'collapsed'] as const) {
            const controls = resolveRenderedAgentInputControls({
                layout,
                singleRow: true,
                containedControlIds: ['engine', 'machine'],
                coreControlNodesById: {
                    engine: [node('engine')], permission: [node('permission')], actionMenu: [node('actionMenu')],
                    machine: [node('machine')], path: [node('path')], resume: [node('resume')],
                },
                extraControlNodesById: { automation: [node('automate')], checkout: [node('worktree')], connectedServices: [node('sign-in')] },
                extraChips: [node('unregistered')],
            });
            expect(keys(controls.chips)).toEqual(['engine', 'machine']);
            expect(controls.secondaryLeadingControls).toEqual([]);
            expect(controls.secondaryTrailingControls).toEqual([]);
            expect(controls.hasPermissionControl).toBe(false);
        }
    });
    it('keeps setup controls on the first rail and the machine on the location rail, whatever the collapsed bar names', () => {
        const node = (key: string) => <React.Fragment key={key}>{key}</React.Fragment>;
        const controls = resolveRenderedAgentInputControls({
            layout: 'scroll',
            coreControlNodesById: { machine: [node('machine')] },
            extraControlNodesById: { workflow: [node('workflow')], workflowInputs: [node('inputs')], workflowRoles: [node('roles')] },
            extraChips: [node('unregistered')], barControlIds: ['workflow'],
        });
        expect(controls.chips.map((chip) => (chip as React.ReactElement).key)).toEqual(['workflow', 'inputs', 'roles', 'unregistered']);
        expect(controls.secondaryLeadingControls.map((chip) => (chip as React.ReactElement).key)).toEqual(['machine']);
    });
    it('splits the location rail around the folder and resume controls: machine first, then workspace and automation chips', () => {
        const node = (key: string) => <React.Fragment key={key}>{key}</React.Fragment>;
        const controls = resolveRenderedAgentInputControls({
            layout: 'scroll',
            coreControlNodesById: { machine: [node('machine')], path: [node('path')], resume: [node('resume')] },
            extraControlNodesById: { automation: [node('automate'), node('triggers')], organization: [node('folder')], checkout: [node('checkout')] },
            extraChips: [],
        });
        const keys = (nodes: readonly React.ReactNode[]) => nodes.map((chip) => (chip as React.ReactElement).key);
        expect(keys(controls.secondaryLeadingControls)).toEqual(['machine']);
        expect(keys(controls.secondaryTrailingControls)).toEqual(['checkout', 'folder', 'automate', 'triggers']);
    });

    it('renders admitted plugin controls at the one plugin insertion point and keeps them in collapsed overflow', () => {
        const pluginControl = <React.Fragment key="plugin-control">Plugin control</React.Fragment>;
        const coreControl = <React.Fragment key="engine-control">Engine control</React.Fragment>;

        const expanded = resolveRenderedAgentInputControls({
            layout: 'wrap',
            coreControlNodesById: { engine: [coreControl] },
            extraControlNodesById: { 'plugin:acme.compose/attach': [pluginControl] },
            extraChips: [],
        });
        expect(expanded.chips).toEqual([coreControl, pluginControl]);

        const collapsed = resolveRenderedAgentInputControls({
            layout: 'collapsed',
            coreControlNodesById: { engine: [coreControl] },
            extraControlNodesById: { 'plugin:acme.compose/attach': [pluginControl] },
            extraChips: [],
        });
        expect(collapsed.chips).toEqual([coreControl, pluginControl]);
    });

    it('shows only the host\'s bar controls, in the host\'s order, when collapsed', () => {
        const node = (key: string) => <React.Fragment key={key}>{key}</React.Fragment>;
        const nodes = { engine: [node('engine')], permission: [node('permission')], actionMenu: [node('actionMenu')], machine: [node('machine')], path: [node('path')], resume: [node('resume')] };
        const collapsed = resolveRenderedAgentInputControls({
            layout: 'collapsed',
            coreControlNodesById: nodes,
            extraControlNodesById: { capabilities: [node('capabilities')], automation: [node('automation')] },
            extraChips: [],
            barControlIds: ['machine', 'path', 'engine', 'permission', 'actionMenu'],
        });
        expect(collapsed.chips.map((chip) => (chip as React.ReactElement).key)).toEqual(['machine', 'path', 'engine', 'permission', 'actionMenu']);

        // Other layouts are unchanged by the host's bar set.
        const wrap = resolveRenderedAgentInputControls({
            layout: 'wrap',
            coreControlNodesById: nodes,
            extraControlNodesById: { capabilities: [node('capabilities')] },
            extraChips: [],
            barControlIds: ['machine'],
        });
        expect(wrap.chips.map((chip) => (chip as React.ReactElement).key)).toContain('capabilities');
    });
});
