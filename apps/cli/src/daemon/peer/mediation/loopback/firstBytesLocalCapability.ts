import { randomBytes, timingSafeEqual } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';

const LOCAL_FIRST_BYTES_CAPABILITY_BYTES = 32;
export const LOCAL_FIRST_BYTES_CAPABILITY_HEX_LENGTH = LOCAL_FIRST_BYTES_CAPABILITY_BYTES * 2;

export function createFirstBytesLocalCapability(): string {
  return randomBytes(LOCAL_FIRST_BYTES_CAPABILITY_BYTES).toString('hex');
}

export function isFirstBytesLocalCapability(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export async function readFirstBytesLocalCapability(socket: Socket): Promise<Buffer> {
  socket.pause();
  const chunks: Buffer[] = [];
  let received = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    const cleanup = () => {
      socket.off('readable', readAvailable);
      socket.off('end', rejectClosed);
      socket.off('close', rejectClosed);
      socket.off('error', reject);
    };
    const rejectClosed = () => {
      cleanup();
      reject(new Error('Local capability was not supplied'));
    };
    const readAvailable = () => {
      while (received < LOCAL_FIRST_BYTES_CAPABILITY_HEX_LENGTH) {
        const chunk = socket.read(LOCAL_FIRST_BYTES_CAPABILITY_HEX_LENGTH - received);
        if (chunk === null) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        chunks.push(bytes);
        received += bytes.byteLength;
      }
      cleanup();
      resolve(Buffer.concat(chunks, LOCAL_FIRST_BYTES_CAPABILITY_HEX_LENGTH));
    };
    socket.on('readable', readAvailable);
    socket.once('end', rejectClosed);
    socket.once('close', rejectClosed);
    socket.once('error', reject);
    readAvailable();
  });
}

export function matchesFirstBytesLocalCapability(supplied: Buffer, expected: Buffer): boolean {
  return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected);
}

async function closeListeningServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export type FirstBytesLocalCapabilityProxy = Readonly<{
  port: number;
  localCapability: string;
  closed: Promise<void>;
  close(): Promise<void>;
}>;

/**
 * Creates one loopback-only, single-connection proxy for an already-authorized
 * application target. The intended native caller must present the random
 * capability as the first bytes; those bytes never reach the application.
 */
export async function startFirstBytesLocalCapabilityProxy(input: Readonly<{
  targetPort: number;
  /** Cancels an abandoned one-shot target until the exact capability is accepted. */
  abortSignalUntilClaimed?: AbortSignal;
  onTargetConnected?: (input: Readonly<{ localPort: number }>) => void;
}>): Promise<FirstBytesLocalCapabilityProxy> {
  input.abortSignalUntilClaimed?.throwIfAborted();
  if (!Number.isInteger(input.targetPort) || input.targetPort < 1 || input.targetPort > 65_535) {
    throw new Error('Local capability proxy target port is invalid');
  }
  const localCapability = createFirstBytesLocalCapability();
  const expectedCapability = Buffer.from(localCapability, 'ascii');
  const server = createServer({ allowHalfOpen: true });
  let accepted: Socket | null = null;
  let target: Socket | null = null;
  const pending = new Set<Socket>();
  let closed = false;
  let closePromise: Promise<void> | null = null;
  const onAbortedBeforeClaim = (): void => {
    if (!accepted) void close();
  };
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      if (closed) return;
      closed = true;
      input.abortSignalUntilClaimed?.removeEventListener('abort', onAbortedBeforeClaim);
      for (const socket of pending) socket.destroy();
      pending.clear();
      accepted?.destroy();
      target?.destroy();
      await closeListeningServer(server);
      resolveClosed();
    })();
    return closePromise;
  };
  server.on('connection', (socket) => {
    if (closed || accepted || socket.remoteAddress !== '127.0.0.1') {
      socket.destroy();
      return;
    }
    pending.add(socket);
    socket.once('close', () => pending.delete(socket));
    void (async () => {
      let supplied: Buffer;
      try {
        supplied = await readFirstBytesLocalCapability(socket);
      } catch {
        socket.destroy();
        return;
      }
      if (closed || accepted || !matchesFirstBytesLocalCapability(supplied, expectedCapability)) {
        socket.destroy();
        return;
      }
      accepted = socket;
      pending.delete(socket);
      for (const pendingSocket of pending) pendingSocket.destroy();
      pending.clear();
      void closeListeningServer(server);
      input.abortSignalUntilClaimed?.removeEventListener('abort', onAbortedBeforeClaim);
      if (closed) return;
      target = connect({ host: '127.0.0.1', port: input.targetPort, allowHalfOpen: true });
      target.setNoDelay(true);
      target.once('connect', () => {
        const targetAddress = target!.address();
        if (typeof targetAddress === 'object' && 'port' in targetAddress) {
          input.onTargetConnected?.({ localPort: targetAddress.port });
        }
        socket.setNoDelay(true);
        // Pipe owns half-close propagation, including an EOF already observed
        // while the outbound application connection was still connecting.
        socket.pipe(target!);
        target!.pipe(socket);
        socket.resume();
      });
      socket.once('error', () => { void close(); });
      socket.once('close', () => { void close(); });
      target.once('error', () => { void close(); });
      target.once('close', () => { void close(); });
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') {
    await close();
    throw new Error('Local capability proxy did not bind');
  }
  input.abortSignalUntilClaimed?.addEventListener('abort', onAbortedBeforeClaim, { once: true });
  if (input.abortSignalUntilClaimed?.aborted) onAbortedBeforeClaim();
  return Object.freeze({
    port: address.port,
    localCapability,
    closed: closedPromise,
    close,
  });
}
