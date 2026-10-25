import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_WIDGET_DESCRIPTORS_V1 } from '@happier-dev/protocol/widgets/builtinWidgetDescriptorV1';
import { PLUGIN_UI_ICON_TOKENS_V1 } from '@happier-dev/protocol/plugins/ui';

const SOURCES_DIR = join(__dirname, '..', '..', '..');
const REGISTRY_FILE = join(__dirname, 'iconRegistry.generated.ts');

/**
 * The registry is an allowlist, so a name it does not know renders as `undefined` — which React
 * throws on, taking down the whole surrounding pane rather than dropping one glyph. That is not
 * hypothetical: the git panel crashed on `diff-added` / `diff-modified`, two Octicons names that
 * survived the Phosphor migration because they reach `Icon` through an `iconName="…"` prop on a
 * wrapper component rather than as `<Icon name="…">`, so neither the codemod nor a naive grep saw
 * them. `Icon` now degrades instead of throwing; this keeps the underlying gap from reappearing.
 */
const NAME_PATTERNS = [
    /<Icon\s+name="([a-z][a-z0-9-]*)"/g,
    /\biconName="([a-z][a-z0-9-]{2,})"/g,
    /\bicon="([a-z][a-z0-9-]{2,})"/g,
    /\b(?:iconName|agentPickerIconName|iconIonName|menuIcon|icon)\s*:\s*['"]([a-z][a-z0-9-]{2,})['"]/g,
];

const PLUGIN_UI_ICON_TOKENS: ReadonlySet<string> = new Set(PLUGIN_UI_ICON_TOKENS_V1);

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            walk(full, out);
        } else if (/\.tsx?$/.test(entry) && !/\.(test|spec)\./.test(entry)) {
            out.push(full);
        }
    }
    return out;
}

describe('icon registry coverage', () => {
    it('registers every builtin widget descriptor icon', () => {
        const registry = new Set(
            [...readFileSync(REGISTRY_FILE, 'utf8').matchAll(/^\s+'([a-z0-9-]+)':/gm)].map((match) => match[1]),
        );
        expect([...new Set(BUILTIN_WIDGET_DESCRIPTORS_V1.map((descriptor) => descriptor.icon))]
            .filter((icon) => !registry.has(icon))).toEqual([]);
    });

    it('registers every icon name the app asks for', () => {
        const registry = new Set(
            [...readFileSync(REGISTRY_FILE, 'utf8').matchAll(/^\s+'([a-z0-9-]+)':/gm)].map((m) => m[1]),
        );
        expect(registry.size).toBeGreaterThan(100);

        const unregistered = new Set<string>();
        for (const file of walk(SOURCES_DIR)) {
            const source = readFileSync(file, 'utf8');
            // Plugin UI components name icons by semantic token (`PluginUiIconTokenV1`), which the
            // plugin icon-token resolver maps into this registry; such a token is not an app name.
            const pluginUiTokens = source.includes("from '@happier-dev/plugin-ui") ? PLUGIN_UI_ICON_TOKENS : null;
            for (const pattern of NAME_PATTERNS) {
                for (const match of source.matchAll(pattern)) {
                    // Picker fields always name icons; elsewhere only multi-word names are
                    // unambiguous, since a bare `icon:` field can also hold a domain value.
                    const isAgentPickerIcon = match[0].startsWith('agentPickerIconName');
                    if ((isAgentPickerIcon || match[1].includes('-')) && !registry.has(match[1]) && !pluginUiTokens?.has(match[1])) unregistered.add(match[1]);
                }
            }
        }

        expect([...unregistered].sort()).toEqual([]);
    });
});
