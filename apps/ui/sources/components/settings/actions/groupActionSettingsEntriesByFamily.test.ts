import { describe, expect, it } from 'vitest';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';

import type { ActionSettingsEntry } from './buildActionSettingsEntries';
import { groupActionSettingsEntriesByFamily } from './groupActionSettingsEntriesByFamily';

function entry(actionId: string, title: string): ActionSettingsEntry {
    return {
        kind: 'host',
        actionId: actionId as Extract<ActionSettingsEntry, { kind: 'host' }>['actionId'],
        title,
        description: null,
        enabled: true,
        targets: [],
    };
}

function contributed(pluginId: string, localId: string, title: string): ActionSettingsEntry {
    return {
        kind: 'contributed',
        actionId: formatQualifiedPluginActionId({ pluginId, localId }) as Extract<ActionSettingsEntry, { kind: 'contributed' }>['actionId'],
        title,
        description: null,
        enabled: true,
        targets: [],
    };
}

describe('groupActionSettingsEntriesByFamily', () => {
    it('gives each contributing plugin its own section, named for the plugin', () => {
        // One "Plugins" bucket mixing every plugin's Actions says nothing about where an Action
        // comes from; provenance is the section, read before the rows, once per plugin.
        const sections = groupActionSettingsEntriesByFamily([
            contributed('happier.triage', 'sources-administer', 'Configure a source'),
            contributed('happier.scm.forge.github', 'scan', 'Scan GitHub pull requests and issues'),
            contributed('happier.triage', 'pin', 'Pin or unpin an entry'),
        ], new Map([
            ['happier.triage', 'PRs & Issues'],
            ['happier.scm.forge.github', 'GitHub'],
        ]));

        expect(sections.map((section) => [section.family, section.title ?? null])).toEqual([
            ['plugins', 'GitHub'],
            ['plugins', 'PRs & Issues'],
        ]);
        expect(sections[1]?.entries.map((candidate) => candidate.title)).toEqual([
            'Configure a source',
            'Pin or unpin an entry',
        ]);
        expect(new Set(sections.map((section) => section.key)).size).toBe(2);
    });

    it('groups entries into ordered family sections with runtime families first', () => {
        const sections = groupActionSettingsEntriesByFamily([
            entry('memory.search', 'Search memory'),
            entry('browser.navigate', 'Navigate browser'),
            entry('devices.simulator.input.tap', 'Tap simulator'),
            entry('browser.reload', 'Reload browser'),
        ]);

        const families = sections.map((section) => section.family);
        expect(families).toEqual(['browser', 'simulator', 'general']);
        // Browser section keeps both browser entries.
        const browser = sections.find((section) => section.family === 'browser')!;
        expect(browser.entries.map((candidate) => candidate.actionId)).toEqual(['browser.navigate', 'browser.reload']);
    });

    it('omits empty families and never emits a section with zero entries', () => {
        const sections = groupActionSettingsEntriesByFamily([entry('session.stop', 'Stop session')]);
        expect(sections).toHaveLength(1);
        expect(sections[0]!.family).toBe('session');
        expect(sections.every((section) => section.entries.length > 0)).toBe(true);
    });

    it('returns no sections for an empty entry list', () => {
        expect(groupActionSettingsEntriesByFamily([])).toEqual([]);
    });

    it('splits resource reads from changes while leaving Session and Source control in their own families', () => {
        const sections = groupActionSettingsEntriesByFamily([
            entry('machines.storage.trash.move', 'Move items to Trash'),
            entry('machines.vitals.get', 'Read vitals'),
            entry('machines.processes.startAgain', 'Start again'),
            entry('machines.resources.policy.get', 'Read resource policy'),
            entry('machines.guard.get', 'Read guard'),
            entry('machines.processes.list', 'List processes'),
            entry('machines.storage.summary.get', 'Read storage summary'),
            entry('machines.resources.policy.set', 'Change resource policy'),
            entry('session.stop', 'Stop session'),
            entry('scm.worktree.remove', 'Remove worktree'),
        ]);

        expect(sections.map((section) => section.family)).toEqual([
            'resources', 'resources', 'session', 'scm',
        ]);
        expect(sections.slice(0, 2).map((section) => section.titleKey)).toEqual([
            'settingsActions.families.resources.reading.title',
            'settingsActions.families.resources.changing.title',
        ]);
        expect(sections[0]?.entries.map((candidate) => candidate.actionId)).toEqual([
            'machines.vitals.get',
            'machines.resources.policy.get',
            'machines.guard.get',
            'machines.processes.list',
            'machines.storage.summary.get',
        ]);
        expect(sections[1]?.entries.map((candidate) => candidate.actionId)).toEqual([
            'machines.storage.trash.move',
            'machines.processes.startAgain',
            'machines.resources.policy.set',
        ]);
        expect(sections[2]?.entries.map((candidate) => candidate.actionId)).toEqual(['session.stop']);
        expect(sections[3]?.entries.map((candidate) => candidate.actionId)).toEqual(['scm.worktree.remove']);
        expect(sections[1]?.relatedActionIds).toEqual(['session.stop', 'scm.worktree.remove']);
    });
});
