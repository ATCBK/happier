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

const publicMcpStringSchema = ResourceSchema.shape.uri;
const publicMcpUnknownSchema = TextContentSchema.shape._meta.unwrap().valueType;
// The curated DTO intentionally exposes annotation hints as plain JSON primitives,
// while the MCP wire schema constrains their values further.
const publicMcpFiniteNumberSchema = publicMcpUnknownSchema.refine(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
);
const publicMcpAnnotationsSchema = AnnotationsSchema.extend({
    priority: publicMcpFiniteNumberSchema.optional(),
    lastModified: publicMcpStringSchema.optional(),
}).strict();
const publicMcpIconSchema = IconSchema.strict();
const publicMcpResourceSchema = ResourceSchema.extend({
    annotations: publicMcpAnnotationsSchema.optional(),
    icons: publicMcpIconSchema.array().optional(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpResourceTemplateSchema = ResourceTemplateSchema.extend({
    annotations: publicMcpAnnotationsSchema.optional(),
    icons: publicMcpIconSchema.array().optional(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpTextResourceContentsSchema = TextResourceContentsSchema.extend({
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpBlobResourceContentsSchema = BlobResourceContentsSchema.extend({
    blob: publicMcpStringSchema,
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpResourceContentsSchema = publicMcpTextResourceContentsSchema.or(publicMcpBlobResourceContentsSchema);
export const publicMcpResourcePageSchema = ListResourcesResultSchema.omit({ resources: true }).extend({
    items: publicMcpResourceSchema.array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
export const publicMcpResourceTemplatePageSchema = ListResourceTemplatesResultSchema.omit({ resourceTemplates: true }).extend({
    items: publicMcpResourceTemplateSchema.array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
export const publicMcpReadResourceResultSchema = ReadResourceResultSchema.extend({
    contents: publicMcpResourceContentsSchema.array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpPromptSchema = PromptSchema.extend({
    arguments: PromptArgumentSchema.strict().array().optional(),
    icons: publicMcpIconSchema.array().optional(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
export const publicMcpPromptPageSchema = ListPromptsResultSchema.omit({ prompts: true }).extend({
    items: publicMcpPromptSchema.array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
const publicMcpPromptContentSchema = TextContentSchema.extend({
    annotations: publicMcpAnnotationsSchema.optional(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict()
    .or(ImageContentSchema.extend({
        data: publicMcpStringSchema,
        annotations: publicMcpAnnotationsSchema.optional(),
        _meta: publicMcpUnknownSchema.optional(),
    }).strict())
    .or(AudioContentSchema.extend({
        data: publicMcpStringSchema,
        annotations: publicMcpAnnotationsSchema.optional(),
        _meta: publicMcpUnknownSchema.optional(),
    }).strict())
    .or(EmbeddedResourceSchema.extend({
        resource: publicMcpResourceContentsSchema,
        annotations: publicMcpAnnotationsSchema.optional(),
        _meta: publicMcpUnknownSchema.optional(),
    }).strict())
    .or(publicMcpResourceSchema.extend({ type: ResourceLinkSchema.shape.type }).strict());
export const publicMcpGetPromptResultSchema = GetPromptResultSchema.extend({
    messages: PromptMessageSchema.extend({ content: publicMcpPromptContentSchema }).strict().array(),
    _meta: publicMcpUnknownSchema.optional(),
}).strict();
export const publicMcpResourceUpdatedEventSchema = ResourceUpdatedNotificationParamsSchema.omit({ _meta: true }).strict();


