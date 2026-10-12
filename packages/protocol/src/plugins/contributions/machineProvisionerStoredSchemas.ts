import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { createProtocolStoredReadSchemaFromPreparedProjection, type ProtocolComposableSchema, type ProtocolStoredReadSchema } from '../actions/protocolComposableSchema.js';

/** Persistence-only reader. It deliberately cannot be used as an Action schema. */
export type MachineProvisionerStoredReaderV1<TOutput> = ProtocolStoredReadSchema<TOutput>;

/** Prepare only on a retained-data read path; descriptor discovery never loads the compiler. */
export function prepareMachineProvisionerStoredSchemas<LI, LO, RI, RO, NI, NO>(schemas: Readonly<{
  launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>; nativeOperation: ProtocolComposableSchema<NI, NO>;
}>): Promise<Readonly<{ launchStored: MachineProvisionerStoredReaderV1<LO>; resourceStored: MachineProvisionerStoredReaderV1<RO>; nativeOperationStored: MachineProvisionerStoredReaderV1<NO> }>>;
export function prepareMachineProvisionerStoredSchemas<LI, LO, RI, RO>(schemas: Readonly<{
  launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>;
}>): Promise<Readonly<{ launchStored: MachineProvisionerStoredReaderV1<LO>; resourceStored: MachineProvisionerStoredReaderV1<RO> }>>;
export async function prepareMachineProvisionerStoredSchemas<LI, LO, RI, RO, NI, NO>(schemas: Readonly<{
  launch: ProtocolComposableSchema<LI, LO>; resource: ProtocolComposableSchema<RI, RO>; nativeOperation?: ProtocolComposableSchema<NI, NO>;
}>) {
  const { createPluginJsonSchemaZodValueAdapter } = await import('../actions/jsonSchemaValidation.js');
  function reader<I, O>(declared: ProtocolComposableSchema<I, O>): MachineProvisionerStoredReaderV1<O> {
    const projection = createStoredReadSchema(createPluginJsonSchemaZodValueAdapter(declared.jsonSchema));
    return createProtocolStoredReadSchemaFromPreparedProjection(declared, projection);
  }
  return Object.freeze({ launchStored: reader(schemas.launch), resourceStored: reader(schemas.resource),
    ...(schemas.nativeOperation ? { nativeOperationStored: reader(schemas.nativeOperation) } : {}),
  });
}
