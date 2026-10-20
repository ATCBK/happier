import type { Socket } from "socket.io";
import { z } from "zod/mini";

const UiFocusStateSchema = z.strictObject({ computer: z.boolean(), focused: z.boolean() });

/** Focus belongs to this live sync socket; disconnect removes it with the socket. */
export function registerUiFocusSocketEvent(socket: Socket, admission?: Promise<boolean>): void {
    socket.on("ui-focus", (input: unknown, ack?: (response: { ok: boolean }) => void) => {
        const apply = (admitted: boolean) => {
            const data = socket.data;
            const parsed = UiFocusStateSchema.safeParse(input);
            const allowed = admitted && socket.connected
                && data.clientType === "user-scoped" && data.clientPurpose === "sync";
            if (allowed && parsed.success) data.uiFocus = parsed.data;
            if (typeof ack === "function") ack({ ok: allowed && parsed.success });
        };
        if (admission) {
            void admission.then(apply, () => apply(false));
        } else {
            apply(true);
        }
    });
}
