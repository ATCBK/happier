import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import type { PreNormalizedActionSpec } from './actionSpecs.js';
import { redactObservationInputPaths } from './specs/observationRedaction.js';
import { WebhookNotificationChannelV1Schema } from '../account/settings/notificationChannels.js';
import { NOTIFICATION_CONFIGURATION_ACTION_IDS } from './notificationConfigurationActionIds.js';
export { NOTIFICATION_CONFIGURATION_ACTION_IDS, isNotificationConfigurationActionId,
  type NotificationConfigurationActionId } from './notificationConfigurationActionIds.js';

const ChannelIdSchema = lazyZodSchema(() => z.string().trim().min(1));
const WebhookUrlSchema = lazyZodSchema(() => z.string().trim().pipe(WebhookNotificationChannelV1Schema.shape.url));
const TopicsPatchSchema = lazyZodSchema(() => z.object({
  ready: z.boolean().optional(), permissionRequest: z.boolean().optional(), userActionRequest: z.boolean().optional(),
  connectedServiceAccountSwitch: z.boolean().optional(), connectedServiceQuotaBlocked: z.boolean().optional(),
  connectedServiceQuotaRecovered: z.boolean().optional(),
}).strict().refine(value => Object.values(value).some(field => field !== undefined)));
const ChannelPatchSchema = lazyZodSchema(() => z.object({
  enabled: z.boolean().optional(), topics: TopicsPatchSchema.optional(),
  readyIncludeMessageText: z.boolean().optional(), requestIncludeMessageText: z.boolean().optional(),
}).strict());
export type NotificationChannelConfigurationPatch = z.infer<typeof ChannelPatchSchema>;
const PatchSchema = lazyZodSchema(() => ChannelPatchSchema.extend({ url: WebhookUrlSchema.optional() })
  .strict().refine(value => Object.values(value).some(field => field !== undefined)));
const ExpoPushPatchSchema = lazyZodSchema(() => ChannelPatchSchema
  .refine(value => Object.values(value).some(field => field !== undefined)));
const ChannelTargetSchema = lazyZodSchema(() => z.object({ channelId: ChannelIdSchema }).strict());
export const NotificationConfigurationActionInputSchemas = {
  'notifications.webhooks.list': z.object({}).strict(),
  'notifications.webhooks.add': z.object({ url: WebhookUrlSchema }).strict(),
  'notifications.webhooks.update': ChannelTargetSchema.extend({ patch: PatchSchema }).strict(),
  'notifications.webhooks.remove': ChannelTargetSchema,
  'notifications.webhooks.signingSecret.set': ChannelTargetSchema.extend({ secret: z.string().min(1) }).strict(),
  'notifications.webhooks.signingSecret.clear': ChannelTargetSchema,
  'notifications.expoPush.update': z.object({ patch: ExpoPushPatchSchema }).strict(),
  'notifications.desktop.permission.read': z.object({}).strict(),
  'notifications.desktop.permission.request': z.object({}).strict(),
  'notifications.push.tokens.list': z.object({}).strict(),
  'notifications.push.tokens.remove': z.object({ tokenId: ChannelIdSchema }).strict(),
  'notifications.push.permission.read': z.object({}).strict(),
  'notifications.push.permission.request': z.object({}).strict(),
  'notifications.push.register': z.object({}).strict(),
} as const;
const MutationOutputSchema = lazyZodSchema(() => z.object({ channelId: ChannelIdSchema }).strict());
const PushTokenRegistrationDiagnosticsSchema = lazyZodSchema(() => z.object({ tokenId: ChannelIdSchema,
  fingerprint: z.string(), isCurrentDevice: z.boolean(), clientServerUrl: z.string().nullable(),
  createdAt: z.number(), updatedAt: z.number() }).strict());
export type PushTokenRegistrationDiagnostics = z.infer<typeof PushTokenRegistrationDiagnosticsSchema>;
export const NotificationConfigurationActionOutputSchemas = {
  'notifications.webhooks.list': z.object({ items: z.array(z.object({
    channelId: ChannelIdSchema, url: WebhookUrlSchema, enabled: z.boolean(), signingSecretConfigured: z.boolean(),
    topics: z.object({ ready: z.boolean(), permissionRequest: z.boolean(), userActionRequest: z.boolean() }).strict(),
    readyIncludeMessageText: z.boolean(), requestIncludeMessageText: z.boolean(),
  }).strict()) }).strict(),
  'notifications.webhooks.add': MutationOutputSchema,
  'notifications.webhooks.update': MutationOutputSchema,
  'notifications.webhooks.remove': MutationOutputSchema,
  'notifications.webhooks.signingSecret.set': MutationOutputSchema,
  'notifications.webhooks.signingSecret.clear': MutationOutputSchema,
  'notifications.expoPush.update': MutationOutputSchema,
  'notifications.desktop.permission.read': z.object({ status: z.enum(['granted', 'notGranted']) }).strict(),
  'notifications.desktop.permission.request': z.object({ status: z.enum(['granted', 'notGranted']) }).strict(),
  'notifications.push.tokens.list': z.object({ tokens: z.array(PushTokenRegistrationDiagnosticsSchema) }).strict(),
  'notifications.push.tokens.remove': z.object({ tokenId: ChannelIdSchema, removed: z.literal(true) }).strict(),
  'notifications.push.permission.read': z.discriminatedUnion('status', [
    z.object({ status: z.literal('ready'), permission: z.object({ status: z.enum(['unsupported', 'granted', 'denied', 'undetermined']),
      granted: z.boolean(), canAskAgain: z.boolean() }).strict() }).strict(),
    z.object({ status: z.literal('unavailable'), reason: z.enum(['runtime_unavailable', 'runtime_timeout']) }).strict(),
  ]),
  'notifications.push.permission.request': z.object({ decision: z.enum(['prime', 'open_system_settings', 'skip_push_disabled',
    'skip_unsupported', 'skip_already_granted', 'skip_already_declined', 'skip_cannot_ask_again', 'skip_runtime_unavailable']),
    granted: z.boolean() }).strict(),
  'notifications.push.register': z.object({ status: z.literal('reconciled') }).strict(),
} as const;

export const NOTIFICATION_CONFIGURATION_ACTION_SPECS = NOTIFICATION_CONFIGURATION_ACTION_IDS.map((id): PreNormalizedActionSpec => ({
  id, approvalPolicy: { uiConfirmation: 'policy',
    ...(id === 'notifications.desktop.permission.request' || id === 'notifications.push.permission.request'
      ? { agentDefault: 'authority' as const, requiredSurfaces: ['agent', 'mcp', 'plugin', 'api'] as const } : {}),
  }, approval: { result: 'required' }, title: {
    'notifications.webhooks.list': 'List notification webhooks', 'notifications.webhooks.add': 'Add notification webhook',
    'notifications.webhooks.update': 'Configure notification webhook', 'notifications.webhooks.remove': 'Remove notification webhook',
    'notifications.webhooks.signingSecret.set': 'Set notification webhook signing secret',
    'notifications.webhooks.signingSecret.clear': 'Clear notification webhook signing secret',
    'notifications.expoPush.update': 'Configure built-in push notifications',
    'notifications.desktop.permission.read': 'Read desktop notification permission',
    'notifications.desktop.permission.request': 'Request desktop notification permission',
    'notifications.push.tokens.list': 'List push notification registrations',
    'notifications.push.tokens.remove': 'Remove push notification registration',
    'notifications.push.permission.read': 'Read native push notification permission',
    'notifications.push.permission.request': 'Request native push notification permission',
    'notifications.push.register': 'Reconcile this device’s push registrations',
  }[id],
  description: id === 'notifications.expoPush.update'
    ? 'Update the existing built-in Expo push endpoint and its corresponding Account attention preferences together. Topic and preview delivery still intersect global topic and privacy rules; absent or deleted endpoints are not recreated.'
    : id.startsWith('notifications.desktop.') ? 'Read or request this desktop’s operating-system notification permission. Automation asks first by default; the OS still owns the permission decision.'
    : id.startsWith('notifications.push.tokens.') ? 'Read or remove the addressed captured Account push registration. Native token material is resolved privately and is never an Action operand or receipt.'
    : id === 'notifications.push.register' ? 'Run the existing device-wide push reconciler for all locally credentialed Homes. Reconciled means the recovery attempt settled; unsupported, denied and unreachable registrations retain the reconciler’s existing skip behavior.'
    : id.startsWith('notifications.push.permission.') ? 'Read or request this device’s native push permission through the existing OS access and priming flow. Automation asks first by default; the OS still owns the permission decision.'
    : 'Configure notification webhooks through the captured Account notification catalog. Signing secret values are write-only.',
  safety: id === 'notifications.webhooks.list' || id === 'notifications.push.tokens.list' || id.startsWith('notifications.desktop.')
    || id.startsWith('notifications.push.permission.') || id === 'notifications.push.register' ? 'safe' : 'danger',
  sideEffectClass: id === 'notifications.webhooks.list' || id === 'notifications.push.tokens.list' || id === 'notifications.desktop.permission.read'
    || id === 'notifications.push.permission.read' ? 'read'
    : id === 'notifications.desktop.permission.request' || id === 'notifications.push.permission.request' || id === 'notifications.push.register' ? 'write' : 'danger',
  requiredAuthority: 'account_automation', executionPlacement: 'client', placements: [],
  bindings: { mcpToolName: id.replace(/[.]/g, '_').replace('signingSecret', 'signing_secret') },
  surfaces: { ui: true, voice: false, agent: true, mcp: true, cli: false, rpc: false },
  toolExposure: { agent: 'discoverable_only', mcp: 'discoverable_only' },
  inputSchema: NotificationConfigurationActionInputSchemas[id], outputSchema: NotificationConfigurationActionOutputSchemas[id],
  inputHints: { fields: [
    ...(!id.startsWith('notifications.webhooks.') || id === 'notifications.webhooks.list' || id === 'notifications.webhooks.add' ? [] : [
      { path: 'channelId', title: 'Webhook id', widget: 'text' as const, required: true },
    ]),
    ...(id === 'notifications.webhooks.add' ? [{ path: 'url', title: 'Webhook URL', widget: 'text' as const, required: true }] : []),
    ...(id === 'notifications.webhooks.update' ? [{ path: 'patch', title: 'Webhook configuration', widget: 'json' as const, required: true }] : []),
    ...(id === 'notifications.expoPush.update' ? [{ path: 'patch', title: 'Push endpoint and Account attention preferences', widget: 'json' as const, required: true }] : []),
    ...(id === 'notifications.push.tokens.remove' ? [{ path: 'tokenId', title: 'Push registration id', widget: 'text' as const, required: true }] : []),
    ...(id === 'notifications.webhooks.signingSecret.set' ? [{ path: 'secret', title: 'Signing secret', widget: 'secret' as const, required: true }] : []),
  ] },
  ...(id === 'notifications.webhooks.signingSecret.set' ? {
    projectObservationInput: redactObservationInputPaths('secret'), approvalInputCustody: 'live_only' as const,
  } : {}),
  ...(id === 'notifications.push.tokens.list' ? { projectObservationOutput: (value: unknown) => {
    const result = NotificationConfigurationActionOutputSchemas['notifications.push.tokens.list'].safeParse(value);
    return result.success ? { tokens: result.data.tokens.map(row => ({ ...row,
      clientServerUrl: row.clientServerUrl === null ? null : '[redacted]' })) } : {};
  } } : {}),
}));
