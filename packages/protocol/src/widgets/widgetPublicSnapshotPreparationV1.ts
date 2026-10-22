import type { PluginContributionIdentityV1 } from '../plugins/contributionIdentity.js';
import { readBuiltinWidgetDescriptorV1 } from './builtinWidgetDescriptorV1.js';
import type { WidgetDefinitionV1 } from './widgetDefinitionV1.js';
import type { WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import type { WidgetDefinitionRefV1, WidgetInputBindingsV1 } from './widgetInstanceV1.js';
import type { WidgetLayoutWidgetV1 } from './widgetLayoutItemV1.js';
import { resolveWidgetPublicSnapshotPresentationV1 } from './widgetPublicProfileAdmissionV1.js';
import { PublicProfileLayoutV1Schema, type PublicProfileLayoutV1 } from './widgetPublicSnapshotV1.js';
import { WidgetAreaLayoutV1Schema, type WidgetAreaLayoutV1 } from './widgetSurfaceArtifactV1.js';

export type WidgetPublicSnapshotSourceV1 = WidgetInputDescriptorV1 & Readonly<{ title?: string }>;
export type WidgetPublicSnapshotPreparationSourcesV1 = Readonly<{
    resolveDefinition(reference: Extract<WidgetDefinitionRefV1, { kind: 'artifact' }>): WidgetDefinitionV1 | null | Promise<WidgetDefinitionV1 | null>;
    resolveInstalledView(surface: PluginContributionIdentityV1): WidgetPublicSnapshotSourceV1 | null | Promise<WidgetPublicSnapshotSourceV1 | null>;
}>;
export class WidgetPublicSnapshotPreparationErrorV1 extends Error {
    constructor(readonly code: 'widget_public_presentation_unavailable', readonly instanceId: string) {
        super(code); this.name = 'WidgetPublicSnapshotPreparationErrorV1';
    }
}

/** Resolve once at reviewed preparation; the copied edition retains no executable definition or lookup. */
export async function compileWidgetAreaPublicProfileLayoutV1(raw: WidgetAreaLayoutV1,
    sources: WidgetPublicSnapshotPreparationSourcesV1): Promise<PublicProfileLayoutV1> {
    const layout = WidgetAreaLayoutV1Schema.parse(raw);
    const definitions = new Map<string, Promise<WidgetDefinitionV1 | null>>();
    const installed = new Map<string, Promise<WidgetPublicSnapshotSourceV1 | null>>();
    const readInstalled = (surface: PluginContributionIdentityV1) => {
        const key = JSON.stringify([surface.pluginId, surface.localId]);
        if (!installed.has(key)) installed.set(key, Promise.resolve(sources.resolveInstalledView(surface)));
        return installed.get(key)!;
    };
    const copy = async (item: WidgetLayoutWidgetV1, groupBindings?: WidgetInputBindingsV1) => {
        const { instance } = item;
        const ref = instance.definition;
        let descriptor: WidgetPublicSnapshotSourceV1 | null;
        let definition: WidgetDefinitionV1 | null = null;
        if (ref.kind === 'builtin') descriptor = readBuiltinWidgetDescriptorV1(ref);
        else if (ref.kind === 'installed') descriptor = await readInstalled(ref.surface);
        else {
            if (ref.kind === 'inline') definition = ref.definition;
            else {
                if (!definitions.has(ref.artifactId)) definitions.set(ref.artifactId, Promise.resolve(sources.resolveDefinition(ref)));
                definition = await definitions.get(ref.artifactId)!;
            }
            const source = definition?.body.kind === 'installed' ? await readInstalled(definition.body.surface) : null;
            descriptor = definition ? { ...source, ...definition, authoredDefinition: definition } : null;
        }
        const presentation = descriptor && resolveWidgetPublicSnapshotPresentationV1(instance, descriptor, groupBindings);
        const size = item.size ?? descriptor?.sizeDeclaration?.defaultSize;
        if (!presentation || !size) throw new WidgetPublicSnapshotPreparationErrorV1('widget_public_presentation_unavailable', instance.id);
        const title = instance.displayName ?? definition?.name ?? descriptor?.title;
        return { kind: 'widget' as const, id: instance.id,
            size, frameStyle: item.frameStyle ?? 'card' as const,
            ...(title ? { title } : {}), presentation };
    };
    const items = await Promise.all(layout.items.map(async item => item.kind === 'widget' ? copy(item) : {
        kind: 'group' as const, id: item.id, width: item.width, frameStyle: item.frameStyle, dividers: item.dividers,
        ...(item.title ? { title: item.title } : {}), children: await Promise.all(item.children.map(child => copy(child, item.context))),
    }));
    return PublicProfileLayoutV1Schema.parse({ v: 1, items });
}
