/**
 * Lets another surface (Settings › Appearance) ask the Home screen to open its own Customize mode,
 * instead of mounting a second copy of Home's editor. A request made while no Home is mounted is kept
 * for the next Home that subscribes, and is delivered once.
 */
type Listener = () => void;

let listener: Listener | null = null;
let pendingRequest = false;

export function requestHomeCustomize(): void {
    if (listener) {
        listener();
        return;
    }
    pendingRequest = true;
}

export function subscribeHomeCustomizeRequest(open: Listener): () => void {
    listener = open;
    if (pendingRequest) {
        pendingRequest = false;
        open();
    }
    return () => {
        if (listener === open) listener = null;
    };
}
