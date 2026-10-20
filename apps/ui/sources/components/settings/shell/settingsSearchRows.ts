import { t } from '@/text';

import type { ResolvedSettingsPageNode, SettingsPageSearchResult } from '@/components/settings/catalog/types';

/**
 * The one row projection of a settings-search result, shared by every surface that lists settings
 * results (the settings rail, the phone Settings page and Search / ⌘K), so a page or a setting reads
 * the same everywhere: its title, matching words when needed, and where it lives ("Appearance › Terminal").
 */
export type SettingsSearchRow = Readonly<{
    kind: 'page' | 'setting';
    /** The page id, or the setting's anchor. */
    id: string;
    title: string;
    /** Matching words when needed, followed by the page/section path joined with " › ". */
    subtitle?: string;
    route: string;
}>;

type PageEntry = Readonly<{ title: string; path: readonly string[] }>;

export type SettingsSearchPageIndex = ReadonlyMap<string, PageEntry>;

const PATH_SEPARATOR = ' › ';

function readNodeTitle(node: ResolvedSettingsPageNode): string {
    return node.title ?? (node.titleKey ? String(t(node.titleKey)) : node.id);
}

/** Each page's title and the group names above it (the catalog root is not part of any path). */
export function indexSettingsSearchPages(tree: readonly ResolvedSettingsPageNode[]): SettingsSearchPageIndex {
    const out = new Map<string, PageEntry>();
    const visit = (nodes: readonly ResolvedSettingsPageNode[], path: readonly string[], depth: number) => {
        for (const node of nodes) {
            const title = readNodeTitle(node);
            out.set(node.id, { title, path });
            if (node.children) visit(node.children, depth === 0 ? [] : [...path, title], depth + 1);
        }
    };
    visit(tree, [], 0);
    return out;
}

/**
 * Splits catalog results into page rows and setting rows, each in the catalog's ranking order.
 * Surfaces show pages first, then settings: the rail under two labels, Search in one group.
 */
export function buildSettingsSearchRows(
    results: readonly SettingsPageSearchResult[],
    pages: SettingsSearchPageIndex,
): Readonly<{ pageRows: readonly SettingsSearchRow[]; settingRows: readonly SettingsSearchRow[] }> {
    const pageRows: SettingsSearchRow[] = [];
    const settingRows: SettingsSearchRow[] = [];
    for (const result of results) {
        if (result.setting) {
            const subtitle = [result.matchText, result.setting.path.join(PATH_SEPARATOR)].filter(Boolean).join(' · ');
            settingRows.push({
                kind: 'setting',
                id: result.setting.anchor,
                title: result.setting.title,
                ...(subtitle ? { subtitle } : {}),
                route: result.route,
            });
            continue;
        }
        const page = pages.get(result.id);
        const subtitle = [result.matchText, page?.path.join(PATH_SEPARATOR)].filter(Boolean).join(' · ');
        pageRows.push({
            kind: 'page',
            id: result.id,
            title: page?.title ?? String(result.id),
            ...(subtitle ? { subtitle } : {}),
            route: result.route,
        });
    }
    return { pageRows, settingRows };
}
