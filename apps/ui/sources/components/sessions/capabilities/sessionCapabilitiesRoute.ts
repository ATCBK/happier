import * as React from 'react';

import {
  useLocalSearchParams,
  useRouter,
} from '@/components/appShell/workspace/destinationRoute';

/** PD13: a sign-in that started from the session sheet returns to `session/<id>?capabilities=open`. */
export const SESSION_CAPABILITIES_OPEN_PARAM = 'capabilities';
export const SESSION_CAPABILITIES_OPEN_VALUE = 'open';

/** The route's request to open "This session gets" once; `consume` clears the param so a later visit doesn't reopen it. */
export function useSessionCapabilitiesOpenRequest(): Readonly<{
  requested: boolean;
  consume: () => void;
}> {
  const params = useLocalSearchParams<{ capabilities?: string | string[] }>();
  const router = useRouter();
  const value = params[SESSION_CAPABILITIES_OPEN_PARAM];
  const requested =
    (Array.isArray(value) ? value[0] : value) ===
    SESSION_CAPABILITIES_OPEN_VALUE;
  const consume = React.useCallback(() => {
    router.setParams({ [SESSION_CAPABILITIES_OPEN_PARAM]: undefined });
  }, [router]);
  return { requested, consume };
}
