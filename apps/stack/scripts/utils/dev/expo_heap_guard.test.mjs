import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startExpoHeapGuard } from './expo_dev_supervision.mjs';

test('heap safeguard derives its watermark from the isolate limit and waits for every HTTP request', async t => {
  let used = 100;
  const recycled = [];
  const guard = startExpoHeapGuard({
    // V8's heap accounting is an OS/runtime boundary. HTTP lifecycle is real.
    readHeapStatistics: () => ({ used_heap_size: used, heap_size_limit: 1000 }),
    onRecycle: state => recycled.push(state),
    intervalMs: 10,
  });
  let finishBundle;
  let admitted;
  const requestAdmitted = new Promise(resolve => { admitted = resolve; });
  const server = createServer((req, res) => {
    if (req.url === '/index.bundle') {
      finishBundle = () => res.end('bundle');
      admitted();
    } else res.end('packager-status:running');
  });
  t.after(async () => {
    guard.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${origin}/status`);
  used = 899;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(recycled.length, 0, 'valid heap usage below the derived watermark must not recycle');
  const bundle = fetch(`${origin}/index.bundle`).then(r => r.text());
  await requestAdmitted;
  used = 901;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(recycled.length, 0, 'an in-flight bundle must complete before any restart');
  finishBundle();
  assert.equal(await bundle, 'bundle');
  const deadline = Date.now() + 2000;
  while (recycled.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(recycled.length, 1);
  assert.equal(recycled[0].heapLimitBytes, 1000);
  assert.equal(recycled[0].thresholdBytes, 900);
  assert.equal(server.listening, false, 'quiet recycling stops accepting new work before notifying the supervisor');
});
