import { ActionExecuteFailureSchema } from '../actions/actionExecutionResult.js';
import type { ActionExecutorDeps } from '../actions/executor/types.js';
import { SessionBoardGetResultV1Schema } from '../sessions/board/actions.js';
import { isSessionSurfaceItemIdentityCorrespondingV1, type SessionSurfaceItemV1 } from '../sessions/board/item.js';
import { WidgetDefinitionDraftV1Schema, projectWidgetDefinitionForSharedPublicationV1, readWidgetDefinitionNetworkOverrideV1 } from './widgetDefinitionV1.js';
import { normalizeUiSurfaceCapabilityRequestV1 } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import type { WidgetDefinitionActionDepsV1 } from './definitionActionsV1.js';
import { readWidgetInputTargetV1, type WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import type { WidgetDefinitionRefV1, WidgetInputBindingsV1 } from './widgetInstanceV1.js';
import { WIDGET_SIZE_ORDER_V1 } from './widgetPresentationV1.js';
import { readBuiltinWidgetDescriptorV1 } from './builtinWidgetDescriptorV1.js';

/** Copy affordances share the promotion owner's representable sources; target admission remains a read-time fact. */
export function canPromoteSessionWidgetDefinitionSourceV1(source: SessionSurfaceItemV1['source']): boolean {
    return source.kind === 'declarative' || source.kind === 'hostedHtml'
        || source.kind === 'widget' && (source.instance.definition.kind === 'inline' || source.instance.definition.kind === 'installed'
            || source.instance.definition.kind === 'builtin' && readBuiltinWidgetDescriptorV1(source.instance.definition) !== null);
}

/** The copy's Session read becomes configurable; UI disclosure consumes this same transformation. */
export function projectWidgetDefinitionPromotionBindingsV1(
    definition: Readonly<{ sessionInputPath?: string }>, bindings: WidgetInputBindingsV1,
): WidgetInputBindingsV1 {
    return { ...bindings, ...(definition.sessionInputPath ? { [definition.sessionInputPath]: { kind: 'context' as const, slot: 'session' } } : {}) };
}

/** Sealed Session content stays with its existing reader and is copied only on explicit promotion. */
export function createSessionWidgetDefinitionSourceReaderV1(input: Readonly<{
    sessionBoardAction: NonNullable<ActionExecutorDeps['sessionBoardAction']>;
    readInstalledDescriptor(definition: Extract<WidgetDefinitionRefV1, { kind: 'installed' }>,
        request: Parameters<NonNullable<WidgetDefinitionActionDepsV1['readSessionWidgetDefinitionSource']>>[0]): Promise<WidgetInputDescriptorV1 | null>;
}>): NonNullable<WidgetDefinitionActionDepsV1['readSessionWidgetDefinitionSource']> {
    const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    return async request => {
        const value = await input.sessionBoardAction({ actionId: 'session.board.get',
            input: { sessionId: request.session.sessionId, itemIds: [request.itemId] },
            context: { ...request.context, serverId: request.session.serverId }, signal: request.signal });
        const refused = ActionExecuteFailureSchema.safeParse(value);
        if (refused.success) return refused.data;
        const board = SessionBoardGetResultV1Schema.safeParse(value);
        if (!board.success || board.data.serverId !== request.session.serverId || board.data.sessionId !== request.session.sessionId) return fail('invalid_action_output');
        if (board.data.incomplete) return fail('widget_definition_source_incomplete');
        const row = board.data.items.find(item => item.itemId === request.itemId);
        const item = row?.item;
        if (!item || !isSessionSurfaceItemIdentityCorrespondingV1(request.itemId, item)) return fail('widget_definition_source_unavailable');
        if (!canPromoteSessionWidgetDefinitionSourceV1(item.source)) return fail('widget_definition_source_unsupported');
        if (item.source.kind === 'declarative') return {
            definition: WidgetDefinitionDraftV1Schema.parse({ name: item.title || request.itemId,
                sizeDeclaration: { sizes: [...WIDGET_SIZE_ORDER_V1], defaultSize: 'medium' },
                body: { kind: 'declarative', document: item.source.document }, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false } }),
            bindings: {},
        };
        if (item.source.kind === 'hostedHtml') return {
            definition: WidgetDefinitionDraftV1Schema.parse({ name: item.title || request.itemId,
                sizeDeclaration: { sizes: [...WIDGET_SIZE_ORDER_V1], defaultSize: 'medium' },
                body: { kind: 'html', source: item.source.source,
                    ...(item.source.requestedCapabilities ? { requestedCapabilities: item.source.requestedCapabilities } : {}) },
                inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false } }),
            bindings: {},
        };
        if (item.source.kind !== 'widget') return fail('widget_definition_source_unsupported');
        if (item.source.instance.definition.kind === 'builtin') {
            const descriptor = readBuiltinWidgetDescriptorV1(item.source.instance.definition);
            if (!descriptor) return fail('widget_definition_source_unavailable');
            const target = readWidgetInputTargetV1(descriptor);
            return { definition: WidgetDefinitionDraftV1Schema.parse({ name: item.title || descriptor.title,
                body: descriptor.definition, sizeDeclaration: descriptor.sizeDeclaration,
                inputs: descriptor.inputs ?? { fields: [] }, inputSchema: descriptor.inputSchema ?? { type: 'object', additionalProperties: false },
                ...(target.kind === 'session' ? { sessionInputPath: target.path } : {}),
                ...(item.source.instance.networkOverride ? { networkOverride: item.source.instance.networkOverride } : {}),
            }), bindings: item.source.instance.bindings };
        }
        if (item.source.instance.definition.kind === 'inline') {
            const { v: _v, id: _id, provenance: _provenance, ...draft } = projectWidgetDefinitionForSharedPublicationV1(item.source.instance.definition.definition);
            if (draft.body.kind === 'html') {
                const effective = normalizeUiSurfaceCapabilityRequestV1(item.source.instance.networkOverride ?? readWidgetDefinitionNetworkOverrideV1(draft));
                if (!effective) return fail('widget_definition_source_unavailable');
                const { network: _network, networkOrigins: _origins, ...capabilities } = draft.body.requestedCapabilities ?? {};
                draft.body = { ...draft.body, requestedCapabilities: { ...capabilities,
                    ...(effective.network === 'origins' ? { networkOrigins: [...effective.networkOrigins] } : { network: effective.network }) } };
            }
            return { definition: WidgetDefinitionDraftV1Schema.parse({ ...draft,
                ...(item.source.instance.networkOverride ? { networkOverride: item.source.instance.networkOverride } : {}) }),
                bindings: item.source.instance.bindings };
        }
        if (item.source.instance.definition.kind !== 'installed') return fail('widget_definition_source_unsupported');
        const descriptor = await input.readInstalledDescriptor(item.source.instance.definition, request);
        request.signal?.throwIfAborted();
        if (!descriptor?.inputSchema || !descriptor.sizeDeclaration) return fail('widget_definition_source_unavailable');
        return { definition: WidgetDefinitionDraftV1Schema.parse({ name: item.title || request.itemId,
            sizeDeclaration: descriptor.sizeDeclaration,
            ...(descriptor.publicPresentation ? { publicPresentation: descriptor.publicPresentation } : {}),
            body: item.source.instance.definition, inputs: descriptor.inputs ?? { fields: [] }, inputSchema: descriptor.inputSchema,
            ...(descriptor.sessionInputPath ? { sessionInputPath: descriptor.sessionInputPath } : {}),
            ...(item.source.instance.networkOverride ? { networkOverride: item.source.instance.networkOverride } : {}),
            ...('connectedAccountPurposeBindings' in descriptor ? { connectedAccountPurposeBindings: descriptor.connectedAccountPurposeBindings } : {}),
        }), bindings: item.source.instance.bindings };
    };
}
