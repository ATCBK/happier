import type { JsonValue } from '../json/strictJsonValue.js';
import { readBuiltinUsagePublicPresentationDescriptorV1, BuiltinUsagePublicPresentationV1Schema } from './builtinWidgetDescriptorV1.js';
import type { WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import type { WidgetDefinitionRefV1, WidgetInstanceV1, WidgetSurfaceRefV1 } from './widgetInstanceV1.js';
import { WidgetPublicSnapshotPresentationV1Schema } from './widgetPublicSnapshotV1.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';

function builtinPublicId(definition: WidgetDefinitionRefV1, descriptor: WidgetInputDescriptorV1) {
    const body = definition.kind === 'inline' ? definition.definition.body : descriptor.authoredDefinition?.body;
    return definition.kind === 'builtin' ? definition.id : body?.kind === 'builtin' ? body.id : null;
}

/** The existing core-page area is private editing state; only reviewed Apply publishes it. */
export function isPublicProfileWidgetSurfaceV1(surface: WidgetSurfaceRefV1): boolean {
    return surface.owner.kind === 'corePage' && surface.owner.pageId === 'public-profile' && surface.owner.area === 'main';
}

/** Project the incumbent declaration to its snapshot inputs, never its executable/private inputs. */
export function projectWidgetPublicProfileDescriptorV1<T extends WidgetInputDescriptorV1>(definition: WidgetDefinitionRefV1, descriptor: T): T | null {
    const builtinId = builtinPublicId(definition, descriptor);
    if (builtinId) {
        const publicDescriptor = readBuiltinUsagePublicPresentationDescriptorV1(builtinId);
        if (!publicDescriptor) return null;
        const schema = publicDescriptor.inputSchema;
        return { ...descriptor, sessionInputPath: undefined, connectedAccountPurposeBindings: undefined,
            inputs: { fields: Object.entries(schema.properties ?? {}).map(([path, property]) => {
                const field = descriptor.inputs?.fields.find(field => field.path === path);
                const choices = property.enum ?? (property.const === undefined ? [] : [property.const]);
                return { path, title: field?.title ?? publicDescriptor.title, widget: 'select' as const, contextMode: 'own' as const,
                    ...(schema.required?.includes(path) ? { required: true } : {}),
                    options: choices.map(value => ({ value, label: field?.options?.find(option => option.value === value)?.label ?? publicDescriptor.title })) };
            }) }, inputSchema: schema };
    }
    const presentation = WidgetPublicSnapshotPresentationV1Schema.safeParse(descriptor.publicPresentation
        ?? (definition.kind === 'inline' ? definition.definition.publicPresentation : undefined));
    if (!presentation.success) return null;
    return { ...descriptor, sessionInputPath: undefined, connectedAccountPurposeBindings: undefined,
        inputs: { fields: [] }, inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
}

/** Explicit Add-to transformation: discard private pins and retain only supported presentation choices. */
export function translateWidgetPublicProfileCopyV1(instance: WidgetInstanceV1, descriptor: WidgetInputDescriptorV1): WidgetInstanceV1 | null {
    const projected = projectWidgetPublicProfileDescriptorV1(instance.definition, descriptor);
    if (!projected) return null;
    const bindings: WidgetInstanceV1['bindings'] = {};
    for (const field of projected.inputs?.fields ?? []) {
        const property = projected.inputSchema?.properties?.[field.path];
        const binding = instance.bindings[field.path];
        const options = property?.enum ?? (property?.const === undefined ? [] : [property.const]);
        const value = binding?.kind === 'value' && (!options.length || options.some(value => sameStrictJsonValue(value, binding.value))) ? binding.value
            : property?.default ?? (options.length === 1 ? options[0] : undefined);
        if (value !== undefined) bindings[field.path] = { kind: 'value', value: value as JsonValue };
    }
    // Names can contain private project/query labels. The destination uses its canonical widget title.
    return { v: 1, id: instance.id, definition: instance.definition, bindings };
}

/** Validate the saved copy as a closed public presentation before any private context/Resource read. */
export function resolveWidgetPublicProfileInputsV1(instance: WidgetInstanceV1, descriptor: WidgetInputDescriptorV1,
    groupBindings?: WidgetInstanceV1['bindings']) {
    const projected = projectWidgetPublicProfileDescriptorV1(instance.definition, descriptor);
    const denied = (reasonCode: string) => ({ status: 'denied' as const, fields: [{ path: 'input', status: 'denied' as const, reasonCode }] });
    if (!projected) return denied('widget_public_profile_presentation_unavailable');
    const fields = new Set(projected.inputs?.fields.map(field => field.path));
    if (instance.networkOverride || Object.keys(groupBindings ?? {}).length || Object.entries(instance.bindings)
        .some(([path, binding]) => !fields.has(path) || binding.kind !== 'value')) return denied('widget_public_profile_input_forbidden');
    const input = Object.fromEntries(Object.entries(instance.bindings).flatMap(([path, binding]) => binding.kind === 'value' ? [[path, binding.value]] : []));
    const builtinId = builtinPublicId(instance.definition, descriptor);
    const parsed = builtinId ? BuiltinUsagePublicPresentationV1Schema.safeParse({ kind: 'usage', widgetId: builtinId, inputs: input }) : null;
    if (parsed && !parsed.success) return denied('widget_public_profile_input_forbidden');
    return { status: 'ready' as const, input: parsed?.success ? parsed.data.inputs : input };
}

/** Preparation copies the same admitted declaration, without a live definition/plugin reference. */
export function resolveWidgetPublicSnapshotPresentationV1(instance: WidgetInstanceV1, descriptor: WidgetInputDescriptorV1,
    groupBindings?: WidgetInstanceV1['bindings']) {
    const result = resolveWidgetPublicProfileInputsV1(instance, descriptor, groupBindings);
    if (result.status !== 'ready') return null;
    const builtinId = builtinPublicId(instance.definition, descriptor);
    if (builtinId) return BuiltinUsagePublicPresentationV1Schema.parse({ kind: 'usage', widgetId: builtinId, inputs: result.input });
    const presentation = descriptor.publicPresentation
        ?? (instance.definition.kind === 'inline' ? instance.definition.definition.publicPresentation : undefined);
    return WidgetPublicSnapshotPresentationV1Schema.parse(presentation);
}
