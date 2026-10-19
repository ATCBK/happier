import { maxCodeUnits } from '../../strings/maxCodeUnits.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import { zodSchemaToJsonSchemaObject } from '../../actions/actionInputJsonSchema.js';

import {
  createProtocolComposableSchema,
  ProtocolValidationError,
} from '../../plugins/actions/protocolComposableSchema.js';

/** The Launch Profile V2 owner's existing trim and UTF-16 length contract. */
export const LaunchProfileIdV2Schema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), maxCodeUnits(256)));

/** Retained predecessor identities are exact nonempty strings; new inline V2 authoring keeps its own stricter contract. */
export const ProfileRecordIdV1Schema = lazyZodSchema(() => z.string().check(z.minLength(1)));

/** Neutral projection of the same parser, for references embedded in Action inputs. */
export const LaunchProfileIdV2ProtocolSchema = createProtocolComposableSchema<string, string>(
  // Zod's non-enumerable Standard Schema annotation is not part of the JSON projection.
  zodSchemaToJsonSchemaObject(LaunchProfileIdV2Schema, { target: 'draft-7' }),
  (input) => {
    const parsed = LaunchProfileIdV2Schema.safeParse(input);
    return parsed.success
      ? { success: true, data: parsed.data }
      : { success: false, error: new ProtocolValidationError(parsed.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: [],
      }))) };
  },
);
