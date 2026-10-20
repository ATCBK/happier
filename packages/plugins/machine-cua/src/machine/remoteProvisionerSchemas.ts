import { defineMachineProvisionerReconciliationSchemas, defineMachineProvisionerSchemas,
    prepareMachineProvisionerStoredSchemas } from '@happier-dev/plugin-sdk/machine-provisioners';
import { ByocLaunchV1Schema, ByocResourceV1Schema, ByocNativeOperationV1Schema } from './remoteSchemas.js';
import { CuaLocalNameSchema } from './schemas.js';

// Native declaration and role validation share C50's one public schema owner.
// Activated native carriers are qualified against exact resources at invocation.
export const ByocReconciliationSchemas = defineMachineProvisionerReconciliationSchemas({
    launch: ByocLaunchV1Schema, resource: ByocResourceV1Schema, nativeOperation: ByocNativeOperationV1Schema,
});
export const ByocProvisionerSchemas = { ...defineMachineProvisionerSchemas({ launch: ByocLaunchV1Schema, resource: ByocResourceV1Schema }),
    acquireResult: ByocReconciliationSchemas.result };

export function byocReconciliationOperation(input: unknown) {
    const request = ByocReconciliationSchemas.input.parse(input);
    return 'nativeOperation' in request ? request.nativeOperation : {
        launch: request.correlation.launch,
        sandboxId: `${request.correlation.launch.cloud}:${CuaLocalNameSchema.parse(`happier-${request.correlation.managedId}`)}`,
    };
}

export function prepareCuaByocStoredSchemas() {
    return prepareMachineProvisionerStoredSchemas({ launch: ByocLaunchV1Schema, resource: ByocResourceV1Schema,
        nativeOperation: ByocNativeOperationV1Schema });
}
