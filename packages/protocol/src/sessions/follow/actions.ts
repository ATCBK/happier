import { z } from 'zod/mini';
import { ACTION_ID_FAMILIES_V1 } from '../../actions/actionIds.js';
import { asProtocolZod } from '../../plugins/actions/internalProtocolZodAdapter.js';
import { SessionIdSchema } from '../idsV1.js';
import { GetSessionFollowResponseSchema, SetSessionFollowRequestSchema, SetSessionFollowResponseSchema, RemoveSessionFollowResponseSchema, GetSessionAutoFollowPreferencesRequestSchema, SetSessionAutoFollowPreferencesRequestSchema, SessionAutoFollowPreferencesResponseSchema } from './api.js';
import { ListSessionFollowSourcesResponseSchema, SetSessionFollowSourceRequestSchema, SetSessionFollowSourceResponseSchema, RemoveSessionFollowSourceResponseSchema } from './sessionFollowSourcesApi.js';

export type SessionFollowActionIdV1 = typeof ACTION_ID_FAMILIES_V1.session_follow[number];
const SessionIdZodSchema = asProtocolZod(SessionIdSchema);
const session = z.strictObject({ sessionId: SessionIdZodSchema });
const destination = z.strictObject({ destinationSessionId: SessionIdZodSchema });
const pair = z.extend(destination, { sourceSessionId: SessionIdZodSchema });
export const SessionFollowActionInputSchemasV1 = Object.freeze({
  'session.follow.get': session,
  'session.follow.set': z.extend(session, SetSessionFollowRequestSchema.shape),
  'session.follow.remove': session,
  'session.follow.preferences.get': GetSessionAutoFollowPreferencesRequestSchema,
  'session.follow.preferences.set': SetSessionAutoFollowPreferencesRequestSchema,
  'session.follow.sources.list': destination,
  'session.follow.sources.set': z.extend(pair, SetSessionFollowSourceRequestSchema.shape),
  'session.follow.sources.remove': pair,
});
export const SessionFollowActionOutputSchemasV1 = Object.freeze({
  'session.follow.get': GetSessionFollowResponseSchema,
  'session.follow.set': SetSessionFollowResponseSchema,
  'session.follow.remove': RemoveSessionFollowResponseSchema,
  'session.follow.preferences.get': SessionAutoFollowPreferencesResponseSchema,
  'session.follow.preferences.set': SessionAutoFollowPreferencesResponseSchema,
  'session.follow.sources.list': ListSessionFollowSourcesResponseSchema,
  'session.follow.sources.set': SetSessionFollowSourceResponseSchema,
  'session.follow.sources.remove': RemoveSessionFollowSourceResponseSchema,
});
export type SessionFollowActionInputV1 = { [K in SessionFollowActionIdV1]: z.input<typeof SessionFollowActionInputSchemasV1[K]> };
export type SessionFollowActionOutputV1 = { [K in SessionFollowActionIdV1]: z.output<typeof SessionFollowActionOutputSchemasV1[K]> };
export function isSessionFollowActionIdV1(value: string): value is SessionFollowActionIdV1 {
  return (ACTION_ID_FAMILIES_V1.session_follow as readonly string[]).includes(value);
}
