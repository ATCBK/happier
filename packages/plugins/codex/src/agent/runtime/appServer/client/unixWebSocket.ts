import { createConnection } from 'node:net';

import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginProcessResult } from '@happier-dev/plugin-sdk/exec';
import type { PluginJsonRpcClient } from '@happier-dev/plugin-sdk/exec/protocol-clients';
import WebSocket, { type RawData } from 'ws';

import { createCodexAppServerRpcError } from '../compatibility.js';

type JsonRpcMessage = Readonly<{
  id?: string | number | null;
  method?: string;
  params?: JsonValue;
  result?: JsonValue;
  error?: Readonly<{ code?: number; message?: string; data?: unknown }>;
}>;

type PendingRequest = Readonly<{
  method: string;
  resolve(value: JsonValue): void;
  reject(error: Error): void;
  dispose(): void;
}>;

export type CodexUnixWebSocketJsonRpcConnection = Readonly<{
  client: PluginJsonRpcClient;
  wait(): Promise<PluginProcessResult>;
  dispose(): Promise<void>;
}>;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function decodeTextFrame(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMessage(value: unknown): JsonRpcMessage | null {
  if (!isRecord(value)) return null;
  const id = typeof value.id === 'string' || typeof value.id === 'number' || value.id === null
    ? value.id
    : undefined;
  return {
    ...(id !== undefined ? { id } : {}),
    ...(typeof value.method === 'string' ? { method: value.method } : {}),
    ...(value.params !== undefined ? { params: value.params as JsonValue } : {}),
    ...(value.result !== undefined ? { result: value.result as JsonValue } : {}),
    ...(isRecord(value.error) ? { error: value.error } : {}),
  };
}

function requestKey(id: string | number | null | undefined): string | null {
  return id === undefined || id === null ? null : `${typeof id}:${String(id)}`;
}

function createAbortError(): Error {
  const error = new Error('Codex app-server request aborted');
  error.name = 'AbortError';
  return error;
}

export async function connectCodexUnixWebSocketJsonRpc(params: Readonly<{
  socketPath: string;
  maxFrameBytes: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
}>): Promise<CodexUnixWebSocketJsonRpcConnection> {
  const socket = new WebSocket('ws://localhost/', {
    createConnection: () => createConnection(params.socketPath),
    perMessageDeflate: false,
    maxPayload: params.maxFrameBytes,
  });
  let disposed = false;
  let terminalError: Error | null = null;
  let nextId = 0;
  let settleWait!: (result: PluginProcessResult) => void;
  const waitPromise = new Promise<PluginProcessResult>((resolve) => {
    settleWait = resolve;
  });
  const pending = new Map<string, PendingRequest>();
  const notificationListeners = new Set<(message: { method: string; params?: JsonValue }) => void | Promise<void>>();
  const requestHandlers = new Map<string, (request: { id: string | number; method: string; params?: JsonValue }) => JsonValue | Promise<JsonValue>>();

  const failPending = (error: Error): void => {
    terminalError ??= error;
    for (const [key, request] of pending) {
      pending.delete(key);
      request.dispose();
      request.reject(terminalError);
    }
  };

  const connectionReady = new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off('error', onError);
      socket.off('close', onCloseBeforeOpen);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off('open', onOpen);
      socket.off('close', onCloseBeforeOpen);
      reject(error);
    };
    const onCloseBeforeOpen = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      reject(new Error('Codex app-server WebSocket closed before connecting'));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onCloseBeforeOpen);
  });

  const send = async (message: Readonly<Record<string, unknown>>): Promise<void> => {
    if (terminalError) throw terminalError;
    if (disposed) throw new Error('Codex app-server client has been disposed');
    const encoded = JSON.stringify(message);
    if (Buffer.byteLength(encoded, 'utf8') > params.maxFrameBytes) {
      throw new Error(`Codex app-server JSON-RPC frame exceeded ${params.maxFrameBytes} bytes`);
    }
    await connectionReady;
    await new Promise<void>((resolve, reject) => {
      socket.send(encoded, (error) => error ? reject(error) : resolve());
    });
  };

  const handleServerRequest = async (message: JsonRpcMessage): Promise<void> => {
    const key = requestKey(message.id);
    if (!key || typeof message.method !== 'string') return;
    const handler = requestHandlers.get(message.method);
    try {
      if (!handler) {
        await send({ id: message.id, error: { code: -32601, message: `No handler registered for ${message.method}` } });
        return;
      }
      const result = await handler({
        id: message.id as string | number,
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      });
      await send({ id: message.id, result: result ?? null });
    } catch (error) {
      await send({ id: message.id, error: { code: -32000, message: asError(error).message } });
    }
  };

  socket.on('message', (data, isBinary) => {
    try {
      if (isBinary) throw new Error('Codex app-server returned an unexpected binary WebSocket frame');
      const text = decodeTextFrame(data);
      if (Buffer.byteLength(text, 'utf8') > params.maxFrameBytes) {
        throw new Error(`Codex app-server JSON-RPC frame exceeded ${params.maxFrameBytes} bytes`);
      }
      const message = readMessage(JSON.parse(text));
      if (!message) throw new Error('Codex app-server returned a non-object JSON-RPC frame');
      const key = requestKey(message.id);
      if (message.method) {
        if (key) {
          void handleServerRequest(message).catch((error) => failPending(asError(error)));
        } else {
          for (const listener of [...notificationListeners]) {
            void Promise.resolve(listener({
              method: message.method,
              ...(message.params !== undefined ? { params: message.params } : {}),
            })).catch((error) => failPending(asError(error)));
          }
        }
        return;
      }
      if (!key) return;
      const request = pending.get(key);
      if (!request) return;
      pending.delete(key);
      request.dispose();
      if (message.error) {
        request.reject(createCodexAppServerRpcError({
          method: request.method,
          code: message.error.code,
          message: message.error.message,
          data: message.error.data,
        }));
      } else {
        request.resolve(message.result ?? null);
      }
    } catch (error) {
      failPending(asError(error));
      socket.terminate();
    }
  });
  socket.on('error', (error) => failPending(error));
  socket.once('close', (code) => {
    const error = terminalError ?? new Error(`Codex app-server WebSocket closed (code=${code})`);
    if (!disposed) failPending(error);
    settleWait({
      termination: {
        observed: code === 1000
          ? { kind: 'exit', exitCode: 0 }
          : { kind: 'signal', signal: `websocket-close-${code}` },
        requestedBy: disposed ? { kind: 'dispose', reason: 'caller' } : { kind: 'none' },
      },
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  if (params.signal) {
    if (params.signal.aborted) {
      socket.terminate();
      throw createAbortError();
    }
    params.signal.addEventListener('abort', () => socket.terminate(), { once: true });
  }

  try {
    await connectionReady;
  } catch (cause) {
    const error = asError(cause);
    // Bun's HTTP adapter can emit a system code without a native syscall.
    // Keep that absence explicit, rather than inventing a kernel observation.
    if (!Object.hasOwn(error, 'syscall')) {
      Object.defineProperty(error, 'syscall', { value: 'unavailable', enumerable: true });
    }
    // sun_path includes its terminating NUL: 104 bytes on Darwin, 108 on Linux.
    // This is diagnostic classification, not another admission limit or retry.
    const maximumPathBytes = process.platform === 'darwin' ? 103 : process.platform === 'linux' ? 107 : undefined;
    Object.assign(error, {
      transport: 'unixWebSocket',
      ...(maximumPathBytes === undefined ? {} : {
        socketPathLengthClass: Buffer.byteLength(params.socketPath) <= maximumPathBytes ? 'within_limit' : 'exceeds_limit',
      }),
    });
    throw error;
  }

  const client: PluginJsonRpcClient = {
    async request(method, requestParams, options) {
      const id = ++nextId;
      const key = requestKey(id)!;
      if (options?.signal?.aborted) throw createAbortError();
      return await new Promise<JsonValue>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        const onAbort = () => {
          if (!pending.delete(key)) return;
          request.dispose();
          reject(createAbortError());
        };
        const request: PendingRequest = {
          method,
          resolve,
          reject,
          dispose() {
            if (timer) clearTimeout(timer);
            options?.signal?.removeEventListener('abort', onAbort);
          },
        };
        pending.set(key, request);
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        const timeoutMs = options?.timeoutMs === null
          ? null
          : options?.timeoutMs ?? params.requestTimeoutMs;
        if (timeoutMs !== null) {
          timer = setTimeout(() => {
            if (!pending.delete(key)) return;
            request.dispose();
            reject(new Error(`Codex app-server request timed out after ${timeoutMs}ms (${method})`));
          }, timeoutMs);
        }
        void send({ jsonrpc: '2.0', id, method, ...(requestParams === undefined ? {} : { params: requestParams }) })
          .catch((error) => {
            if (!pending.delete(key)) return;
            request.dispose();
            reject(asError(error));
          });
      });
    },
    async notify(method, notificationParams) {
      await send({ jsonrpc: '2.0', method, ...(notificationParams === undefined ? {} : { params: notificationParams }) });
    },
    onNotification(listener) {
      notificationListeners.add(listener);
      return { dispose: () => { notificationListeners.delete(listener); } };
    },
    onRequest(method, listener) {
      requestHandlers.set(method, listener);
      return { dispose: () => {
        if (requestHandlers.get(method) === listener) requestHandlers.delete(method);
      } };
    },
    async dispose() {
      await connection.dispose();
    },
  };

  const connection: CodexUnixWebSocketJsonRpcConnection = {
    client,
    wait: async () => await waitPromise,
    async dispose() {
      if (disposed) return;
      disposed = true;
      failPending(new Error('Codex app-server client has been disposed'));
      notificationListeners.clear();
      requestHandlers.clear();
      socket.terminate();
      await waitPromise;
    },
  };
  return connection;
}
