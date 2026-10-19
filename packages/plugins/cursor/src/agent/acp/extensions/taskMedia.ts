import type { z as zodMiniCore0 } from 'zod/mini';

import {
  cursorGenerateImageNotificationSchema,
  cursorTaskNotificationSchema,
  type CursorGenerateImageNotification,
  type CursorTaskNotification,
} from './schemas.js';

export function parseCursorTaskRequest(
  value: unknown,
): zodMiniCore0.core.util.SafeParseResult<CursorTaskNotification> {
  return cursorTaskNotificationSchema.safeParse(value);
}

export function parseCursorGeneratedMedia(
  value: unknown,
): zodMiniCore0.core.util.SafeParseResult<CursorGenerateImageNotification> {
  return cursorGenerateImageNotificationSchema.safeParse(value);
}
