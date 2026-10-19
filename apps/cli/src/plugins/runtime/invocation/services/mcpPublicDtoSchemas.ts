import { z } from 'zod/mini';

import {
    AnnotationsSchema,
    AudioContentSchema,
    BlobResourceContentsSchema,
    EmbeddedResourceSchema,
    GetPromptResultSchema,
    IconSchema,
    ImageContentSchema,
    ListPromptsResultSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesResultSchema,
    PromptArgumentSchema,
    PromptMessageSchema,
    PromptSchema,
    ReadResourceResultSchema,
    ResourceLinkSchema,
    ResourceSchema,
    ResourceTemplateSchema,
    ResourceUpdatedNotificationParamsSchema,
    TextContentSchema,
    TextResourceContentsSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Keep the SDK's exact child validators. Host-owned containers are native Mini;
// functional extend/omit would clone the supplier's Classic constructor instead.
const publicMcpStringSchema = ResourceSchema.shape.uri;
const publicMcpUnknownSchema = TextContentSchema.shape._meta._zod.def.innerType._zod.def.valueType;
// The curated DTO intentionally exposes annotation hints as plain JSON primitives,
// while the MCP wire schema constrains their values further.
const publicMcpFiniteNumberSchema = z.unknown().check(z.refine(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
));
const publicMcpAnnotationsSchema = z.strictObject({
    ...AnnotationsSchema.shape,
    priority: z.optional(publicMcpFiniteNumberSchema),
    lastModified: z.optional(publicMcpStringSchema),
});
const publicMcpIconSchema = z.strictObject(IconSchema.shape);
const publicMcpResourceSchema = z.strictObject({
    ...ResourceSchema.shape,
    annotations: z.optional(publicMcpAnnotationsSchema),
    icons: z.optional(z.array(publicMcpIconSchema)),
    _meta: z.optional(publicMcpUnknownSchema),
});
const publicMcpResourceTemplateSchema = z.strictObject({
    ...ResourceTemplateSchema.shape,
    annotations: z.optional(publicMcpAnnotationsSchema),
    icons: z.optional(z.array(publicMcpIconSchema)),
    _meta: z.optional(publicMcpUnknownSchema),
});
const publicMcpTextResourceContentsSchema = z.strictObject({
    ...TextResourceContentsSchema.shape,
    _meta: z.optional(publicMcpUnknownSchema),
});
const publicMcpBlobResourceContentsSchema = z.strictObject({
    ...BlobResourceContentsSchema.shape,
    blob: publicMcpStringSchema,
    _meta: z.optional(publicMcpUnknownSchema),
});
const publicMcpResourceContentsSchema = z.union([publicMcpTextResourceContentsSchema, publicMcpBlobResourceContentsSchema]);
const { resources: _sdkResources, ...resourcePageShape } = ListResourcesResultSchema.shape;
export const publicMcpResourcePageSchema = z.strictObject({
    ...resourcePageShape,
    items: z.array(publicMcpResourceSchema),
    _meta: z.optional(publicMcpUnknownSchema),
});
const { resourceTemplates: _sdkResourceTemplates, ...resourceTemplatePageShape } = ListResourceTemplatesResultSchema.shape;
export const publicMcpResourceTemplatePageSchema = z.strictObject({
    ...resourceTemplatePageShape,
    items: z.array(publicMcpResourceTemplateSchema),
    _meta: z.optional(publicMcpUnknownSchema),
});
export const publicMcpReadResourceResultSchema = z.strictObject({
    ...ReadResourceResultSchema.shape,
    contents: z.array(publicMcpResourceContentsSchema),
    _meta: z.optional(publicMcpUnknownSchema),
});
const publicMcpPromptSchema = z.strictObject({
    ...PromptSchema.shape,
    arguments: z.optional(z.array(z.strictObject(PromptArgumentSchema.shape))),
    icons: z.optional(z.array(publicMcpIconSchema)),
    _meta: z.optional(publicMcpUnknownSchema),
});
const { prompts: _sdkPrompts, ...promptPageShape } = ListPromptsResultSchema.shape;
export const publicMcpPromptPageSchema = z.strictObject({
    ...promptPageShape,
    items: z.array(publicMcpPromptSchema),
    _meta: z.optional(publicMcpUnknownSchema),
});
// Keep the supplier-derived binary union grouping and its nested issue structure.
const publicMcpPromptContentSchema = z.union([
    z.union([
        z.union([
            z.union([
                z.strictObject({
                    ...TextContentSchema.shape,
                    annotations: z.optional(publicMcpAnnotationsSchema),
                    _meta: z.optional(publicMcpUnknownSchema),
                }),
                z.strictObject({
                    ...ImageContentSchema.shape,
                    data: publicMcpStringSchema,
                    annotations: z.optional(publicMcpAnnotationsSchema),
                    _meta: z.optional(publicMcpUnknownSchema),
                }),
            ]),
            z.strictObject({
                ...AudioContentSchema.shape,
                data: publicMcpStringSchema,
                annotations: z.optional(publicMcpAnnotationsSchema),
                _meta: z.optional(publicMcpUnknownSchema),
            }),
        ]),
        z.strictObject({
            ...EmbeddedResourceSchema.shape,
            resource: publicMcpResourceContentsSchema,
            annotations: z.optional(publicMcpAnnotationsSchema),
            _meta: z.optional(publicMcpUnknownSchema),
        }),
    ]),
    z.strictObject({ ...publicMcpResourceSchema.shape, type: ResourceLinkSchema.shape.type }),
]);
export const publicMcpGetPromptResultSchema = z.strictObject({
    ...GetPromptResultSchema.shape,
    messages: z.array(z.strictObject({ ...PromptMessageSchema.shape, content: publicMcpPromptContentSchema })),
    _meta: z.optional(publicMcpUnknownSchema),
});
const { _meta: _sdkUpdatedMeta, ...resourceUpdatedShape } = ResourceUpdatedNotificationParamsSchema.shape;
export const publicMcpResourceUpdatedEventSchema = z.strictObject(resourceUpdatedShape);


