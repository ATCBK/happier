import { createServer } from 'node:net';

// Ask the real OS for an available loopback port, then release it before the
// production owner performs its own admission. This is not a port reservation.
export async function allocateAvailableLocalhostPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise((resolve) => server.close(resolve));
    throw new Error('expected an allocated localhost TCP port');
  }
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}
