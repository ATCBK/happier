/**
 * Node's Expo boundary has no mounted SDK scene. Native route journeys provide
 * their local RouteNode explicitly; all workspace title decisions remain real.
 */
export function useRouteNode(): Readonly<{ contextKey: string }> | null {
    return null;
}
