import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ActionExecuteFailureSchema } from '../../actions/actionExecutionResult.js';

export const PERSONAL_SAVED_SECRET_ACTION_IDS_V1 = ['secrets.list', 'secrets.create', 'secrets.update', 'secrets.delete'] as const;
export type PersonalSavedSecretActionIdV1 = typeof PERSONAL_SAVED_SECRET_ACTION_IDS_V1[number];
const identity = () => z.string().min(1);
const name = () => z.string().trim().min(1).max(100);
const kind = () => z.enum(['apiKey', 'token', 'password', 'other']);
// These established Action field names carry the private resource's revision,
// an opaque concurrency token, rather than an invented wall-clock timestamp.
const revision = () => z.number().int().positive();
export const PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1 = {
  'secrets.list': lazyZodSchema(() => z.object({}).strict()),
  'secrets.create': lazyZodSchema(() => z.object({ name: name(), kind: kind().optional(), value: identity() }).strict()),
  'secrets.update': lazyZodSchema(() => z.object({ secretId: identity(), name: name().optional(), value: identity().optional(),
    expectedUpdatedAt: revision() }).strict()),
  'secrets.delete': lazyZodSchema(() => z.object({ secretId: identity(), expectedUpdatedAt: revision() }).strict()),
};
export const PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1 = {
  'secrets.list': lazyZodSchema(() => z.object({ secrets: z.array(z.object({ secretId: identity(), name: name(), kind: kind(),
    updatedAt: revision() }).strict()) }).strict()),
  'secrets.create': lazyZodSchema(() => z.object({ secretId: identity(), secretRef: identity() }).strict()),
  'secrets.update': lazyZodSchema(() => z.object({ secretId: identity(), updatedAt: revision() }).strict()),
  'secrets.delete': lazyZodSchema(() => z.object({ deleted: z.literal(true) }).strict()),
};

export type PersonalSavedSecretMetadataV1 = Readonly<{ secretId: string; name: string; kind: z.infer<ReturnType<typeof kind>>; revision: number }>;
/** Hosts adapt the incumbent private-resource writer, never a Settings writer. */
export type PersonalSavedSecretActionPortV1 = Readonly<{
  list(): Promise<readonly PersonalSavedSecretMetadataV1[]>;
  create(input: z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.create']>): Promise<Readonly<{ secretId: string; secretRef: string }>>;
  update(input: z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.update']>): Promise<Readonly<{ revision: number }>>;
  delete(input: z.infer<typeof PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1['secrets.delete']>): Promise<void>;
}>;
export function createPersonalSavedSecretActionExecuteV1(port: PersonalSavedSecretActionPortV1) {
  return async (actionId: PersonalSavedSecretActionIdV1, raw: unknown): Promise<unknown> => {
    try {
    switch (actionId) {
      case 'secrets.list':
        PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw);
        return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse({ secrets: (await port.list()).map(({ revision, ...secret }) => ({ ...secret, updatedAt: revision })) });
      case 'secrets.create':
        return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse(await port.create(PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw)));
      case 'secrets.update': {
        const input = PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw);
        if (input.name === undefined && input.value === undefined) throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' });
        const result = await port.update(input);
        return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse({ secretId: input.secretId, updatedAt: result.revision });
      }
      case 'secrets.delete':
        await port.delete(PERSONAL_SAVED_SECRET_ACTION_INPUT_SCHEMAS_V1[actionId].parse(raw));
        return PERSONAL_SAVED_SECRET_ACTION_OUTPUT_SCHEMAS_V1[actionId].parse({ deleted: true });
    }
    } catch (error) {
      // Hosts report typed private-resource refusals. Preserve their admitted
      // code/details at this family owner, not in separate client adapters.
      const refusal = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? ActionExecuteFailureSchema.safeParse({ ok: false, errorCode: error.code, error: error.message || error.code,
            ...('details' in error && error.details !== undefined ? { details: error.details } : {}) }) : null;
      if (refusal?.success) return refusal.data;
      throw error;
    }
  };
}
