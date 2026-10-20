import type { SessionHumanPresenceLocationV1 } from "@happier-dev/protocol/sessions";

const PREFIX = "session-human-presence:";
const DISCUSSION_PREFIX = "session-human-presence-discussion:";

export type HumanPresenceLocation = Readonly<
    { sessionId: string; discussionId?: never } | { sessionId?: never; discussionId: string }
>;

export function sessionHumanPresenceRoom(sessionId: string): string {
    return `${PREFIX}${sessionId}`;
}

export function discussionHumanPresenceRoom(location: SessionHumanPresenceLocationV1): string {
    return `${DISCUSSION_PREFIX}${encodeURIComponent(location.discussionId)}`;
}

export function sessionHumanPresenceLocationRoom(location: HumanPresenceLocation): string {
    return location.discussionId === undefined
        ? sessionHumanPresenceRoom(location.sessionId)
        : discussionHumanPresenceRoom({ discussionId: location.discussionId });
}

export function sessionHumanPresenceLocationFromRoom(room: string): HumanPresenceLocation | null {
    if (room.startsWith(DISCUSSION_PREFIX)) {
        try {
            const discussionId = decodeURIComponent(room.slice(DISCUSSION_PREFIX.length));
            return discussionId ? { discussionId } : null;
        } catch {
            return null;
        }
    }
    return room.startsWith(PREFIX) ? { sessionId: room.slice(PREFIX.length) } : null;
}

export function sessionHumanPresenceLocationsFromRooms(rooms: Iterable<string>): HumanPresenceLocation[] {
    return [...rooms].map(sessionHumanPresenceLocationFromRoom)
        .filter((location): location is HumanPresenceLocation => location !== null)
        .sort((left, right) => sessionHumanPresenceLocationRoom(left).localeCompare(sessionHumanPresenceLocationRoom(right)));
}

export function sessionIdsFromHumanPresenceRooms(rooms: Iterable<string>): string[] {
    return sessionHumanPresenceLocationsFromRooms(rooms)
        .flatMap(location => location.sessionId === undefined ? [] : [location.sessionId]);
}
