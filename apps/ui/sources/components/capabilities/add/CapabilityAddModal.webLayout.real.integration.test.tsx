// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { View } from 'react-native';
import { expect, it, vi } from 'vitest';

import { installWebLayoutBridge, measureWebLayout } from '@/dev/testkit/render/measureWebLayout';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { CapabilityAddModalBody, type CapabilityAddModalConfig } from './CapabilityAddModal';

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

installWebLayoutBridge();

type Entry = Readonly<{ name: string; added: boolean }>;
const entries: readonly Entry[] = [
    { name: 'docx', added: false },
    { name: 'pdf', added: true },
    { name: 'webapp-testing', added: false },
];

const config: CapabilityAddModalConfig<Entry> = {
    title: 'Add a skill',
    modes: [{ key: 'browse', label: 'Browse', icon: 'magnifying-glass', kind: 'catalog' }],
    catalog: {
        query: '',
        onQueryChange: () => {},
        searchPlaceholder: 'Search skills',
        items: entries,
        itemKey: (entry) => entry.name,
        anatomy: buildCapabilityCollectionAnatomy<Entry>({
            title: (entry) => entry.name,
            description: () => 'Create and edit documents, with tracked changes and comments, in a long enough line to wrap.',
            // A row that was already added says so at its title line's end and has no button; the others carry one.
            whereSummary: (entry) => (entry.added ? 'Added' : null),
            action: (entry) => (entry.added ? null : <View testID={`add-button:${entry.name}`} style={{ width: 56, height: 28 }} />),
            facts: () => ({ presentation: 'row' }),
            accessibilityLabel: (entry) => entry.name,
            testID: (entry) => `row:${entry.name}`,
        }),
        loading: false,
        empty: null,
    },
    renderDetail: () => null,
    detailFooter: () => ({ primary: { label: 'Add', onPress: async () => null } }),
    testID: 'add',
};

it.each([1440, 390])('keeps every catalog row clear of the dialog edges, whatever its trailing control, at %i px', async (width) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
        await act(async () => root.render(
            <View style={{ width, height: 800 }}>
                <CapabilityAddModalBody config={config} onClose={() => {}} setChrome={() => {}} />
            </View>,
        ));
        const layout = await measureWebLayout(host, { viewport: { width, height: 800 }, texts: ['Added', 'docx'], settle: (replay) => act(replay) });
        const added = layout.textRects('Added')[0]!;
        const button = layout.rect('add-button:docx');
        // The row's trailing edge is one edge: a status at the title's end and a button end on the same line, inset.
        expect.soft(Math.abs(added.right - button.right)).toBeLessThanOrEqual(1);
        expect.soft(width - added.right).toBeGreaterThanOrEqual(16);
        // The rows start on the tools band's edge: the first tab sits a segmented-bar padding inside it.
        expect.soft(Math.abs(layout.textRects('docx')[0]!.left - layout.rect('add:mode:browse').left)).toBeLessThanOrEqual(3);
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
