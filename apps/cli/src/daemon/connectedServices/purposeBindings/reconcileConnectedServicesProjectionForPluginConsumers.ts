export async function reconcileConnectedServicesProjectionForPluginConsumers<TNotification>(
  input: Readonly<{
    notification: TNotification;
    reconcile(notification: TNotification): Promise<void>;
    invalidateConfiguredExternalSessionSources(): void;
    invalidateConnectedAccounts(): void;
  }>,
): Promise<void> {
  if (typeof input.notification === 'object' && input.notification !== null
    && 'quotaRefreshOnly' in input.notification && input.notification.quotaRefreshOnly === true) {
    input.invalidateConnectedAccounts();
    return;
  }
  try {
    input.invalidateConfiguredExternalSessionSources();
    await input.reconcile(input.notification);
  } finally {
    input.invalidateConnectedAccounts();
  }
}
