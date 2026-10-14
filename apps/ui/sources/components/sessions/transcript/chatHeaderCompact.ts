import * as React from 'react';

/**
 * True while the session header's title would get less room than its trailing actions. Actions that have a
 * compact form (the "need you" pill becomes its count) take it, so the session's name stays readable.
 */
export const ChatHeaderCompactContext = React.createContext(false);

/**
 * True while the title and its whole accessory (the role chip) no longer fit on the title line. The
 * accessory then takes its compact form (the role's mark) instead of being cut to a fragment.
 */
export const ChatHeaderTitleAccessoryCompactContext = React.createContext(false);
