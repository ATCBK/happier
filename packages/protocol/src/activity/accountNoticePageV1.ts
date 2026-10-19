import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { defineStoredReadProjection } from '../json/storedReadSchema.js';
import { PluginUiSubPathV1Schema } from '../plugins/ui/semanticCommands.js';

/** Shared plugin-local page routing; identity and routing fields stay closed. */
export const AccountNoticePageV1Schema = lazyZodSchema(() => z.strictObject({
  pageId: z.string().check(z.minLength(1)), subPath: z.optional(PluginUiSubPathV1Schema),
}));
defineStoredReadProjection(AccountNoticePageV1Schema, () => AccountNoticePageV1Schema);
