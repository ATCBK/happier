export { createBoatNativeClient } from './machine/nativeClient.js';
export type { BoatAcquireResult, BoatNativeClientOptions, BoatOptions, BoatSize } from './machine/nativeClient.js';
export { BoatAcquireOperationV1Schema, BoatDeleteOperationV1Schema, BoatLaunchV1Schema, BoatNativeOperationV1Schema, BoatResourceV1Schema } from './machine/schemas.js';
export type { BoatAcquireOperationV1, BoatDeleteOperationV1, BoatLaunchV1, BoatNativeOperationV1, BoatResourceV1 } from './machine/schemas.js';
import { PLUGIN } from './manifest.js';
export { MACHINE_PROVISIONER, PLUGIN, PLUGIN_MANIFEST, PLUGIN_MANIFEST as manifest, ROLE_SCHEMAS, prepareStoredSchemas } from './manifest.js';
export const activate = PLUGIN.activate;
