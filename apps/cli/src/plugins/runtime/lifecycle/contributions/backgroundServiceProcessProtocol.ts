/** Private, same-host IPC. The uint32 prefix is the wire's representable frame boundary. */
export function encodeBackgroundServiceProcessFrame(value: unknown): Buffer {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.byteLength);
    return Buffer.concat([header, body]);
}

export function createBackgroundServiceProcessFrameDecoder(): Readonly<{
    push(chunk: Buffer): unknown[];
}> {
    let buffered: Buffer = Buffer.alloc(0);
    return {
        push(chunk) {
            buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
            const frames: unknown[] = [];
            while (buffered.length >= 4) {
                const length = buffered.readUInt32BE(0);
                if (buffered.length < length + 4) break;
                frames.push(JSON.parse(buffered.subarray(4, length + 4).toString('utf8')));
                buffered = buffered.subarray(length + 4);
            }
            return frames;
        },
    };
}

export type BackgroundServiceProcessMessage =
    | Readonly<{ kind: 'initialize'; bootstrap: unknown }>
    | Readonly<{ kind: 'ready'; pid: number }>
    | Readonly<{ kind: 'run'; id: string; context: unknown; services: unknown; localPolicy?: unknown }>
    | Readonly<{ kind: 'abort'; id: string }>
    | Readonly<{ kind: 'settled'; id: string }>
    | Readonly<{ kind: 'failed'; id: string; error: Readonly<{ code: string; message: string }> }>
    | Readonly<{ kind: 'services'; message: unknown }>
    | Readonly<{ kind: 'stop' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Unknown top-level fields never gain routing or authority on this private boundary. */
export function parseBackgroundServiceProcessMessage(value: unknown): BackgroundServiceProcessMessage {
    if (!isRecord(value) || typeof value.kind !== 'string') throw new Error('background_service_protocol_invalid');
    let keys: readonly string[];
    switch (value.kind) {
        case 'initialize': keys = ['kind', 'bootstrap']; break;
        case 'ready':
            if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0) throw new Error('background_service_protocol_invalid');
            keys = ['kind', 'pid']; break;
        case 'run':
            if (typeof value.id !== 'string' || !value.id) throw new Error('background_service_protocol_invalid');
            keys = ['kind', 'id', 'context', 'services', ...(value.localPolicy === undefined ? [] : ['localPolicy'])]; break;
        case 'abort':
        case 'settled':
            if (typeof value.id !== 'string' || !value.id) throw new Error('background_service_protocol_invalid');
            keys = ['kind', 'id']; break;
        case 'failed':
            if (typeof value.id !== 'string' || !isRecord(value.error)
                || typeof value.error.code !== 'string' || typeof value.error.message !== 'string'
                || Object.keys(value.error).some(key => key !== 'code' && key !== 'message')) {
                throw new Error('background_service_protocol_invalid');
            }
            keys = ['kind', 'id', 'error']; break;
        case 'services': keys = ['kind', 'message']; break;
        case 'stop': keys = ['kind']; break;
        default: throw new Error('background_service_protocol_invalid');
    }
    if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
        throw new Error('background_service_protocol_invalid');
    }
    return value as BackgroundServiceProcessMessage;
}
