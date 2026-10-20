import * as React from 'react';

import { useSavedSecretCatalog } from '@/components/secrets/useSavedSecretCatalog';
import { useRegistrySuggestions } from '@/registries/useRegistrySuggestions';
import { useLocalSettingMutable } from '@/sync/domains/state/storage';

import { buildMcpServerCollection } from '../collection/mcpServerCollectionModel';
import { useMcpSignInViewOf } from '../signIn/useMcpSignInViewOf';
import { useMcpServersSettings } from '../useMcpServersSettings';
import { buildMcpHome } from './mcpHomeModel';

/**
 * The homepage's data: the Account's servers, their sign-in grants and saved keys, the registry's
 * suggestions (P4's one rule) and this device's first-visit dismissal, folded by `buildMcpHome`.
 */
export function useMcpHome() {
  const { settings, snapshot, scope, reload } = useMcpServersSettings();
  const rows = React.useMemo(
    () => buildMcpServerCollection(settings, ''),
    [settings],
  );
  const signInOf = useMcpSignInViewOf(settings, scope);
  const savedSecretCatalog = useSavedSecretCatalog({ scope });
  const { resolveReference } = savedSecretCatalog;
  const secretAvailability = React.useMemo(() => ({ resolveReference }), [resolveReference]);
  const shelf = useRegistrySuggestions('mcpServer');
  const [dismissedAt, setDismissedAt] = useLocalSettingMutable(
    'mcpFirstVisitDismissedAt',
  );
  const suggestions = React.useMemo(
    () =>
      shelf.items.map((item) => ({
        key: `suggestion:${item.sourceId}:${item.itemId}`,
        iconUrl: item.iconUrl ?? null,
        title: item.title,
      })),
    [shelf.items],
  );
  const model = React.useMemo(
    () =>
      buildMcpHome({
        rows,
        signInOf,
        savedSecretCatalog: secretAvailability,
        firstVisitDismissed: dismissedAt !== null,
        suggestions,
      }),
    [dismissedAt, rows, secretAvailability, signInOf, suggestions],
  );
  const dismissFirstVisit = React.useCallback(
    () => setDismissedAt(Date.now()),
    [setDismissedAt],
  );
  const loading = snapshot.status === 'loading' && settings.servers.length === 0;
  // A partial read that shows nothing is not "no servers yet": it says it couldn't load, with a retry.
  const unavailable =
    (snapshot.status === 'unavailable' || snapshot.status === 'partial') &&
    settings.servers.length === 0;
  return {
    model,
    suggestions,
    shelf,
    loading,
    unavailable,
    reload,
    dismissFirstVisit,
  };
}
