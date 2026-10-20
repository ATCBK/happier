/**
 * Lightweight TCP port forwarder using Node.js built-in `net` module.
 *
 * Used to expose Expo dev server (which binds to LAN IP) on the Tailscale interface,
 * enabling remote device access over Tailscale without modifying Expo's binding behavior.
 *
 * Can be run standalone:
 *   node tcp_forward.mjs --listen-host=100.x.y.z --listen-port=8081 --target-host=192.168.1.50 --target-port=8081
 *
 * Or imported and spawned as a managed child process.
 */

import net from 'node:net';

const stopPromises = new WeakMap();

/**
 * Create a TCP forwarding server.
 *
 * @param {Object} options
 * @param {string} options.listenHost - Host/IP to listen on (e.g., Tailscale IP)
 * @param {number} options.listenPort - Port to listen on
 * @param {string} options.targetHost - Host/IP to forward to (e.g., LAN IP or 127.0.0.1)
 * @param {number} options.targetPort - Port to forward to
 * @param {string} [options.label] - Label for logging (default: 'tcp-forward')
 * @returns {net.Server}
 */
export function createTcpForwarder({ listenHost, listenPort, targetHost, targetPort, label = 'tcp-forward' }) {
  let upstream = normalizeUpstream({ targetHost, targetPort });
  const activePairs = new Set();

  const server = net.createServer((clientSocket) => {
    const target = upstream;
    const targetSocket = net.createConnection({ host: target.targetHost, port: target.targetPort }, () => {
      // Connection established, pipe data both ways
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });
    const pair = { clientSocket, targetSocket, target };
    activePairs.add(pair);
    const cleanupPair = () => {
      activePairs.delete(pair);
      clientSocket.unpipe(targetSocket);
      targetSocket.unpipe(clientSocket);
    };

    // Handle errors on both sockets
    clientSocket.on('error', (err) => {
      if (err.code !== 'ECONNRESET') {
        process.stderr.write(`[${label}] client error: ${err.message}\n`);
      }
      targetSocket.destroy();
    });

    targetSocket.on('error', (err) => {
      if (err.code !== 'ECONNRESET' && err.code !== 'ECONNREFUSED') {
        process.stderr.write(`[${label}] target error: ${err.message}\n`);
      }
      clientSocket.destroy();
    });

    // Clean up on close
    clientSocket.on('close', () => {
      cleanupPair();
      targetSocket.destroy();
    });
    targetSocket.on('close', () => {
      cleanupPair();
      clientSocket.destroy();
    });
  });

  server.setUpstream = (nextTarget) => {
    upstream = normalizeUpstream({
      targetHost: nextTarget?.targetHost || upstream.targetHost,
      targetPort: nextTarget?.targetPort || upstream.targetPort,
    });
    return { ...upstream };
  };

  server.getUpstream = () => ({ ...upstream });

  server.getActiveConnectionCount = () => activePairs.size;

  server.closeConnectionsAfterGrace = async ({ graceMs = 0, target = null } = {}) => {
    const delayMs = Math.max(0, Number(graceMs) || 0);
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const normalizedTarget = target ? normalizeUpstream(target) : null;
    const pairsToClose = [...activePairs].filter((pair) => (
      !normalizedTarget || upstreamsEqual(pair.target, normalizedTarget)
    ));
    const closing = [];
    for (const pair of pairsToClose) {
      const waitClient = waitForSocketClose(pair.clientSocket);
      const waitTarget = waitForSocketClose(pair.targetSocket);
      pair.clientSocket.destroy();
      pair.targetSocket.destroy();
      closing.push(waitClient, waitTarget);
    }
    if (closing.length === 0) return;
    await Promise.race([
      Promise.allSettled(closing),
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  };
  server.closeIdleOrAllConnectionsAfterGrace = server.closeConnectionsAfterGrace;

  server.on('error', (err) => {
    process.stderr.write(`[${label}] server error: ${err.message}\n`);
  });

  return server;
}

function normalizeUpstream({ targetHost, targetPort }) {
  const host = String(targetHost || '').trim();
  const port = Number(targetPort);
  if (!host) throw new Error('targetHost is required');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`targetPort must be a valid TCP port, got ${targetPort}`);
  }
  return { targetHost: host, targetPort: port };
}

function upstreamsEqual(left, right) {
  return left.targetHost === right.targetHost && left.targetPort === right.targetPort;
}

function waitForSocketClose(socket) {
  if (!socket || socket.destroyed || socket.closed) return Promise.resolve();
  return new Promise((resolve) => socket.once('close', resolve));
}

/**
 * Start a TCP forwarder and return a promise that resolves when listening.
 *
 * @param {Object} options - Same as createTcpForwarder
 * @returns {Promise<{ server: net.Server, address: string, port: number }>}
 */
export async function startTcpForwarder(options) {
  const { listenHost, listenPort, label = 'tcp-forward' } = options;
  const server = createTcpForwarder(options);

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const address = typeof addr === 'object' ? addr.address : listenHost;
      const port = typeof addr === 'object' ? addr.port : listenPort;
      process.stdout.write(`[${label}] forwarding ${address}:${port} -> ${options.targetHost}:${options.targetPort}\n`);
      resolve({ server, address, port });
    });
  });
}

export async function startTcpForwarderGroup({ forwards, label = 'tcp-forward-group' } = {}) {
  if (!Array.isArray(forwards) || forwards.length === 0) {
    throw new Error('forwards must be a non-empty array');
  }
  const forwarders = [];
  try {
    for (const [index, forward] of forwards.entries()) {
      // Bind in declaration order so a partial startup can be unwound
      // deterministically before the owner reports failure.
      // eslint-disable-next-line no-await-in-loop
      forwarders.push(await startTcpForwarder({
        ...forward,
        label: forward?.label || `${label}-${index + 1}`,
      }));
    }
  } catch (error) {
    await Promise.allSettled(forwarders.map(({ server }) => stopTcpForwarder(server, label)));
    throw error;
  }
  return {
    forwarders,
    async stop() {
      await Promise.allSettled(forwarders.map(({ server }) => stopTcpForwarder(server, label)));
    },
  };
}

function trySendIpc(msg) {
  try {
    if (typeof process.send === 'function') {
      process.send(msg);
    }
  } catch {
    // ignore
  }
}

/**
 * Gracefully stop a TCP forwarder server.
 *
 * @param {net.Server} server
 * @param {string} [label]
 * @returns {Promise<void>}
 */
export async function stopTcpForwarder(server, label = 'tcp-forward') {
  if (!server) return;
  const existingStop = stopPromises.get(server);
  if (existingStop) return existingStop;

  const stopPromise = (async () => {
    const closeActive = typeof server.closeConnectionsAfterGrace === 'function'
      ? server.closeConnectionsAfterGrace({ graceMs: 0 })
      : typeof server.closeIdleOrAllConnectionsAfterGrace === 'function'
        ? server.closeIdleOrAllConnectionsAfterGrace({ graceMs: 0 })
        : Promise.resolve();

    const closed = new Promise((resolve, reject) => {
      const onClose = (error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      };
      try {
        server.close(onClose);
      } catch (error) {
        onClose(error);
      }
    });
    await Promise.all([closed, closeActive]);
    process.stdout.write(`[${label}] stopped\n`);
  })();
  stopPromises.set(server, stopPromise);
  return stopPromise;
}

// Standalone CLI mode
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const kv = new Map();
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) kv.set(m[1], m[2]);
  }

  const listenHost = kv.get('listen-host') || kv.get('listenHost');
  const listenPort = Number(kv.get('listen-port') || kv.get('listenPort'));
  const targetHost = kv.get('target-host') || kv.get('targetHost') || '127.0.0.1';
  const targetPort = Number(kv.get('target-port') || kv.get('targetPort'));
  const label = kv.get('label') || 'tcp-forward';
  const forwardsJson = kv.get('forwards-json') || '';

  let forwardGroup = null;
  if (forwardsJson) {
    try {
      const parsed = JSON.parse(forwardsJson);
      if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('expected a non-empty array');
      forwardGroup = parsed;
    } catch (error) {
      console.error(`Invalid --forwards-json: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }

  if (!forwardGroup && (!listenHost || !listenPort || !targetPort)) {
    console.error('Usage: node tcp_forward.mjs --listen-host=<ip> --listen-port=<port> --target-host=<ip> --target-port=<port> [--label=<label>]');
    process.exit(1);
  }

  let runningGroup = null;
  const shutdown = async () => {
    process.stdout.write(`\n[${label}] shutting down...\n`);
    await runningGroup?.stop?.();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  const startup = forwardGroup
    ? startTcpForwarderGroup({ forwards: forwardGroup, label })
    : startTcpForwarder({ listenHost, listenPort, targetHost, targetPort, label });

  startup
    .then((started) => {
      runningGroup = forwardGroup
        ? started
        : { stop: () => stopTcpForwarder(started.server, label) };
      trySendIpc({ type: 'ready', listenHost, listenPort, targetHost, targetPort, label });
      // Keep running until signal
    })
    .catch((err) => {
      trySendIpc({
        type: 'error',
        code: err && typeof err === 'object' ? err.code : null,
        message: err instanceof Error ? err.message : String(err ?? 'unknown error'),
        listenHost,
        listenPort,
        targetHost,
        targetPort,
        label,
      });
      console.error(`[${label}] failed to start: ${err.message}`);
      process.exit(1);
    });
}
