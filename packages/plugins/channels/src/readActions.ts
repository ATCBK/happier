import { type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import {
  ConversationConnectionListInputV1Schema, ConversationConnectionListResultV1Schema,
  ConversationBindingListInputV1Schema, ConversationBindingListResultV1Schema,
  ConversationIngressAttentionInputV1Schema, ConversationIngressAttentionResultV1Schema,
  ConversationDeliveryAttentionInputV1Schema, ConversationDeliveryAttentionResultV1Schema,
  ConversationDeliveryReadInputV1Schema, ConversationDeliveryReadResultV1Schema,
} from '@happier-dev/channels-protocol/v1';
import { CHANNEL_STATE_COLLECTION, CHANNEL_DELIVERIES_COLLECTION } from './collections.js';
import { readConversationConnectionManagementPage, readConversationBindingManagementPage,
  readConversationIngressAttentionPage } from './accountLocalBindingPolicy.js';
import { readConversationOutwardDeliveryResolutionPage,
  readConversationOutwardDeliveryDetail } from './outwardDelivery.js';
import { projectConversationConnectionDeliveryAttention } from './connectionsResource.js';
import { requireChannelsAccountStorage } from './requiredAccountStorage.js';

/** Management reads use admitted Account storage; provider reconciliation remains separately fenced. */
export async function listConversationConnectionsForInvocation(input: JsonValue, context: PluginInvocationContext) {
  const request = ConversationConnectionListInputV1Schema.parse(input);
  const storage = requireChannelsAccountStorage(context);
  const page = await readConversationConnectionManagementPage({ ...request,
    collection: storage.collection(CHANNEL_STATE_COLLECTION), signal: context.signal });
  const connections = await projectConversationConnectionDeliveryAttention({
    deliveriesCollection: storage.collection(CHANNEL_DELIVERIES_COLLECTION), signal: context.signal,
    connections: page.connections,
  });
  return ConversationConnectionListResultV1Schema.parse({ ...page, connections });
}
export async function listConversationBindingsForInvocation(input: JsonValue, context: PluginInvocationContext) {
  return ConversationBindingListResultV1Schema.parse(await readConversationBindingManagementPage({
    ...ConversationBindingListInputV1Schema.parse(input),
    collection: requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION), signal: context.signal,
  }));
}
export async function readConversationIngressAttentionForInvocation(input: JsonValue, context: PluginInvocationContext) {
  return ConversationIngressAttentionResultV1Schema.parse(await readConversationIngressAttentionPage({
    ...ConversationIngressAttentionInputV1Schema.parse(input),
    collection: requireChannelsAccountStorage(context).collection(CHANNEL_STATE_COLLECTION), signal: context.signal,
  }));
}
export async function readConversationDeliveryAttentionForInvocation(input: JsonValue, context: PluginInvocationContext) {
  return ConversationDeliveryAttentionResultV1Schema.parse(await readConversationOutwardDeliveryResolutionPage({
    ...ConversationDeliveryAttentionInputV1Schema.parse(input),
    deliveriesCollection: requireChannelsAccountStorage(context).collection(CHANNEL_DELIVERIES_COLLECTION), signal: context.signal,
  }));
}
export async function readConversationDeliveryForInvocation(input: JsonValue, context: PluginInvocationContext) {
  return ConversationDeliveryReadResultV1Schema.parse(await readConversationOutwardDeliveryDetail({
    ...ConversationDeliveryReadInputV1Schema.parse(input),
    deliveriesCollection: requireChannelsAccountStorage(context).collection(CHANNEL_DELIVERIES_COLLECTION), signal: context.signal,
  }));
}
