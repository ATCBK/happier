import * as React from 'react';

/**
 * True while the session header's title would get less room than its trailing actions. Actions that have a
 * compact form (the "need you" pill becomes its count) take it, so the session's name stays readable.
 */
export const ChatHeaderCompactContext = React.createContext(false);
