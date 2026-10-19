import {
    CURRENT_UI_CONTEXT_ATTACHMENT_IDENTITY_V1 as canonicalAttachmentIdentity,
    CurrentUiContextSnapshotV1AttachmentSchema,
} from '@happier-dev/protocol/plugins/ui/currentUiContext';
import type { CurrentUiContextSnapshotV1, PluginUiSchema } from '../ui/publicContract.js';
import type { PluginJsonSchema } from './protocolFacade.js';

/** Standalone canonical snapshot declaration, deliberately not a composable schema. */
export const ProtocolCurrentUiContextSnapshotV1Schema: PluginUiSchema<CurrentUiContextSnapshotV1> & Readonly<{
    jsonSchema: PluginJsonSchema;
}> = CurrentUiContextSnapshotV1AttachmentSchema;

export const CURRENT_UI_CONTEXT_ATTACHMENT_IDENTITY_V1: Readonly<{
    pluginId: 'happier.app-context'; localId: 'current-screen';
}> = canonicalAttachmentIdentity;
