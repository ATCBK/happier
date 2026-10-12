import React from 'react';

import { useOptionalAuth } from '@/auth/context/AuthContext';
import { useAtmosphereMoment } from '@/components/atmosphere/atmosphereMoments';
import { themeHorizonTransition } from './themeHorizonTransition.web';
import { registerWebThemePreferenceChoreography } from './themePreferenceTransition';

/** On web the theme switch is the atmosphere's Horizon moment while its switch is on; otherwise the wipe. */
export function ThemePreferenceTransitionHost(
  props: Readonly<{ children: React.ReactNode }>,
) {
  const { on } = useAtmosphereMoment('themeSwitch');
  const signedIn = useOptionalAuth()?.isAuthenticated === true;
  React.useEffect(
    () =>
      on && signedIn
        ? registerWebThemePreferenceChoreography(themeHorizonTransition)
        : undefined,
    [on, signedIn],
  );
  return <>{props.children}</>;
}
