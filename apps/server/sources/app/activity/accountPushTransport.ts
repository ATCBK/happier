import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import { collectExpoPushTokensMarkedUnregistered } from '@happier-dev/protocol/push/expoPushDelivery';

import { db } from "@/storage/db";
import { log } from "@/utils/logging/log";

const expo = new Expo();

export type AccountPushDelivery = Readonly<{
    accountId: string;
    token: string;
    message: ExpoPushMessage;
}>;

async function deleteInvalidAccountPushTokens(deliveries: ReadonlyArray<AccountPushDelivery>): Promise<void> {
    if (deliveries.length === 0) return;
    await db.accountPushToken.deleteMany({
        where: {
            OR: deliveries.map((delivery) => ({
                accountId: delivery.accountId,
                token: delivery.token,
            })),
        },
    });
}

/**
 * The one Account push transport: chunking, ticket inspection, and invalid-token
 * cleanup for every Account-addressed Expo message this Home submits.
 *
 * Badge refresh and the remote-alert leg differ only in payload; a second copy
 * of this loop would let their token cleanup and chunking drift apart.
 */
export async function sendAccountExpoPushMessages(
    deliveries: ReadonlyArray<AccountPushDelivery>,
    logModule: string,
): Promise<void> {
    const validDeliveries = deliveries.filter((delivery) => Expo.isExpoPushToken(delivery.message.to));
    if (validDeliveries.length === 0) return;
    const invalidDeliveries = new Map<string, AccountPushDelivery>();
    let deliveryOffset = 0;

    for (const chunk of expo.chunkPushNotifications(validDeliveries.map((delivery) => delivery.message))) {
        const chunkDeliveries = validDeliveries.slice(deliveryOffset, deliveryOffset + chunk.length);
        deliveryOffset += chunk.length;
        try {
            const ticketChunk = await expo.sendPushNotificationsAsync(chunk);
            const invalidTokens = new Set(
                collectExpoPushTokensMarkedUnregistered({
                    messages: chunk,
                    tickets: ticketChunk,
                }),
            );
            if (invalidTokens.size > 0) {
                for (const delivery of chunkDeliveries) {
                    if (!invalidTokens.has(delivery.token)) continue;
                    invalidDeliveries.set(`${delivery.accountId}:${delivery.token}`, delivery);
                }
            }
        } catch (error) {
            log({ module: logModule, level: "warn" }, "failed to send Expo push chunk", error);
        }
    }

    await deleteInvalidAccountPushTokens([...invalidDeliveries.values()]);
}
