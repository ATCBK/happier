import type { PluginCancellationOptions } from '@happier-dev/plugin-sdk';
import type { PluginInvocableActionId } from '@happier-dev/plugin-sdk/actions';
import type { PluginUiActionInputFor, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';

const actions = { read: 'doc.read', comment: 'doc.comment.reply', propose: 'doc.edit.propose',
  accept: 'doc.edit.accept', decline: 'doc.edit.decline' } as const satisfies Readonly<Record<string, PluginInvocableActionId>>;

/** A real external author consumes the host's generated Action inputs and public facade. */
export async function readExternalDoc(api: PluginUiHostApi,
  input: PluginUiActionInputFor<'doc.read'>, options?: PluginCancellationOptions) {
  return api.executeAction(actions.read, input, options);
}

export async function commentOnExternalDoc(api: PluginUiHostApi,
  input: PluginUiActionInputFor<'doc.comment.reply'>, options?: PluginCancellationOptions) {
  return api.executeAction(actions.comment, input, options);
}

export async function proposeExternalDocEdit(api: PluginUiHostApi,
  input: PluginUiActionInputFor<'doc.edit.propose'>, options?: PluginCancellationOptions) {
  return api.executeAction(actions.propose, input, options);
}

export async function requestExternalDocAcceptance(api: PluginUiHostApi,
  input: PluginUiActionInputFor<'doc.edit.accept'>, options?: PluginCancellationOptions) {
  return api.executeAction(actions.accept, input, options);
}

export async function requestExternalDocDecline(api: PluginUiHostApi,
  input: PluginUiActionInputFor<'doc.edit.decline'>, options?: PluginCancellationOptions) {
  return api.executeAction(actions.decline, input, options);
}
