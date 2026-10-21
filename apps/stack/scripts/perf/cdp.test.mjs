import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createCdpConnection } from '../../../ui/scripts/perf/agentBrowserUiPerfAudit.mjs';
import { startCapture } from './capture.mjs';

test('the existing audit CDP transport delivers unsolicited events alongside request responses and rejects pending work on disconnect', async t => {
  const server = createServer();
  let ownedSocket;
  server.on('upgrade', (request, socket) => {
    ownedSocket = socket;
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', bytes => {
      if ((bytes[0] & 15) !== 1) return;
      const length = bytes[1] & 127;
      assert.ok(length < 126, 'fixture commands fit one short WebSocket frame');
      const mask = bytes.subarray(2, 6);
      const body = Buffer.from(bytes.subarray(6, 6 + length));
      for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
      const message = JSON.parse(body.toString());
      const send = value => { const data = Buffer.from(JSON.stringify(value)); socket.write(Buffer.concat([Buffer.from([129, data.length]), data])); };
      if (message.method === 'Runtime.enable') {
        send({ method: 'Network.loadingFinished', params: { requestId: 'one' } });
        send({ id: message.id, result: { enabled: true } });
      } else socket.destroy();
    });
  });
  t.after(() => { ownedSocket?.destroy(); server.close(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = await createCdpConnection(`ws://127.0.0.1:${server.address().port}/devtools/page/test`);
  t.after(() => client.close());
  const events = [];
  client.on('Network.loadingFinished', event => events.push(event.requestId));
  assert.deepEqual(await client.send('Runtime.enable'), { enabled: true });
  assert.deepEqual(events, ['one']);
  await assert.rejects(client.send('Profiler.start'), /closed|error/i);
});

test('capture composes CDP events, safe network records, telemetry and mapped CPU output through the public collector', async t => {
  let ownedSocket;
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ id: 'owned', type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/page` }]));
  });
  t.after(() => { ownedSocket?.destroy(); server.close(); });
  const epoch = Date.now();
  const rendererDelayMs = 15827;
  let rendererClockRequests = 0;
  const asyncDepthCommands = [];
  const map = 'data:application/json;base64,' + Buffer.from(JSON.stringify({ version: 3, sources: ['src/Owner.ts'], names: ['realOwner'], mappings: 'AAAAA' })).toString('base64');
  server.on('upgrade', (request, socket) => {
    ownedSocket = socket;
    const accept = createHash('sha1').update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    const send = value => {
      const body = Buffer.from(JSON.stringify(value));
      const header = body.length < 126 ? Buffer.from([129, body.length]) : Buffer.from([129, 126, body.length >> 8, body.length & 255]);
      socket.write(Buffer.concat([header, body]));
    };
    socket.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 2) {
        const opcode = buffered[0] & 15;
        let length = buffered[1] & 127, offset = 2;
        if (length === 126) { if (buffered.length < 4) return; length = buffered.readUInt16BE(2); offset = 4; }
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4), body = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
        buffered = buffered.subarray(offset + 4 + length);
        if (opcode !== 1) continue;
        for (let index = 0; index < body.length; index++) body[index] ^= mask[index % 4];
        const message = JSON.parse(body.toString());
        let result = {};
        if (message.method === 'Debugger.setAsyncCallStackDepth') asyncDepthCommands.push(message.params.maxDepth);
        if (message.method === 'Debugger.getStackTrace') result.stackTrace = { description: 'never-save description',
          callFrames: [{ functionName: 'asyncOwner', url: 'http://app.test/issuer.js?token=never-save', lineNumber: 4, columnNumber: 2 }] };
        if (message.method === 'Debugger.enable') send({ method: 'Debugger.scriptParsed', params: { scriptId: '1', url: 'http://app.test/bundle.js', sourceMapURL: map } });
        if (message.method === 'Page.addScriptToEvaluateOnNewDocument') result.identifier = 'probe';
        if (message.method === 'Performance.getMetrics') result.metrics = [{ name: 'Timestamp', value: 10 }];
        // OS/CDP boundary simulation: the renderer clock is sampled 15.827s
        // later than Performance.Timestamp, without spending that wall time.
        if (message.method === 'Runtime.evaluate' && message.params.expression === 'Date.now()') rendererClockRequests++;
        if (message.method === 'Runtime.evaluate') result = { result: { value: message.params.expression === 'Date.now()' ? epoch + rendererDelayMs
          : message.params.expression === 'location.href' ? 'http://app.test/'
          : message.params.expression.includes('.collect()') ? { commits: 2, renders: 3, components: {}, longTasks: [], renderers: [{ version: '19' }], telemetryAvailable: true,
            telemetry: { events: [{ name: 'sync.store.storage.notify', count: 2 }] } } : undefined } };
        if (message.method === 'Profiler.start') {
          const timestamp = 10 + (Date.now() - epoch) / 1000;
          send({ method: 'Network.webSocketFrameReceived', params: { timestamp, response: { opcode: 1, payloadData: '42["before-native-pair",{}]' } } });
          send({ method: 'Network.requestWillBeSent', params: { requestId: 'n', wallTime: Date.now() / 1000, timestamp,
            request: { method: 'GET', url: 'http://app.test/v1/data?key=never-save' }, initiator: { type: 'script', stack: { callFrames: [],
              parent: { callFrames: [{ functionName: 'inlineScheduler', url: 'http://app.test/scheduler.js?token=never-save', lineNumber: 1, columnNumber: 0 }],
                parentId: { id: 'out-of-line', debuggerId: 'fixture' }, description: 'never-save description' } } } } });
          send({ method: 'Network.responseReceived', params: { requestId: 'n', timestamp, response: { status: 200, headers: { 'x-request-id': 'returned-id' },
            timing: { requestTime: timestamp, sendStart: 0, receiveHeadersStart: 0 } } } });
          send({ method: 'Network.loadingFinished', params: { requestId: 'n', timestamp, encodedDataLength: 25 } });
          for (const [requestId, delta] of [['canceled', 0], ['unknown-failure', 0], ['late', 0], ['outside', 1000]]) send({ method: 'Network.requestWillBeSent', params: {
            requestId, wallTime: Date.now() / 1000 + delta + (requestId === 'outside' ? .5 : 0), timestamp: timestamp + delta,
            request: { method: 'GET', url: 'http://app.test/v1/data' }, initiator: { type: 'script' } } });
          send({ method: 'Network.loadingFailed', params: { requestId: 'canceled', timestamp, canceled: true, errorText: 'net::ERR_ABORTED' } });
          send({ method: 'Network.loadingFailed', params: { requestId: 'unknown-failure', timestamp, errorText: 'never-save private URL or diagnostic' } });
          send({ method: 'Runtime.bindingCalled', params: { name: '__happierPerfTelemetry', payload: '{"events":[{"name":"sync.store.storage.notify","count":3}]}' } });
          send({ method: 'Runtime.bindingCalled', params: { name: '__happierPerfTelemetry', payload: '{"events":[{"name":"sync.store.storage.notify","count":3}]}' } });
          send({ method: 'Network.webSocketFrameReceived', params: { timestamp, response: { opcode: 1, payloadData: '42["update",{"token":"never-save"}]' } } });
        }
        if (message.method === 'Profiler.stop') {
          send({ method: 'Network.loadingFinished', params: { requestId: 'late', timestamp: 1010, encodedDataLength: 50 } });
          result.profile = { startTime: 0, endTime: 1000,
          nodes: [{ id: 1, callFrame: { scriptId: '1', url: 'http://app.test/bundle.js', functionName: 'a', lineNumber: 0, columnNumber: 0 } }], samples: [1], timeDeltas: [1000] };
        }
        send({ id: message.id, result });
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const capture = await startCapture({ cdp: `http://127.0.0.1:${server.address().port}`, cache: 'warm', captureMode: 'counts' });
  try {
    await capture.begin();
    const result = await capture.finish();
    assert.equal(result.network.requests, 4);
    assert.deepEqual(result.network.records.find(row => row.requestId === 'n').initiator.stack.map(frame => frame.functionName),
      ['inlineScheduler', 'asyncOwner'], 'inline and out-of-line async parents must use the same safe frame projection');
    assert.equal(asyncDepthCommands[0] > 0, true);
    assert.equal(result.network.records.find(row => row.requestId === 'n').startMs,
      result.network.records.find(row => row.requestId === 'n').nativeWallTime * 1000,
      'membership uses the native coherent wall clock, not a delayed renderer sample');
    assert.equal(result.clock.rendererRoundTripUsed, false);
    assert.equal(rendererClockRequests, 0, 'a delayed renderer must never be the wall/monotonic clock source');
    assert.ok(result.clock.nativePairs.length >= 5);
    assert.equal(result.network.encodedBytes, 25);
    assert.equal(result.network.encodedBytesObserved, 75);
    assert.equal(result.network.dispositions.canceled, 1);
    assert.equal(result.network.dispositions.completedAfterWindow, 1);
    assert.equal(result.network.records.find(row => row.requestId === 'canceled').failureCode, 'net::ERR_ABORTED');
    assert.equal(result.network.records.find(row => row.requestId === 'n').sendToHeadersMs, 0);
    assert.equal(result.network.records.find(row => row.requestId === 'n').ttfbBasis, 'response.timing.receiveHeadersStart');
    assert.equal(result.network.records.find(row => row.requestId === 'unknown-failure').canceled, null, 'missing cancellation flag is unknown, not false');
    assert.equal(result.network.records.find(row => row.requestId === 'unknown-failure').failureCode, 'unclassified');
    assert.equal(result.network.records.find(row => row.requestId === 'n').serverRequestId, 'returned-id');
    assert.equal(result.telemetry.reduce((sum, summary) => sum + summary.events[0].count, 0), 8);
    assert.deepEqual(result.sockets.map(row => row.event), ['before-native-pair', 'update'], 'buffer early sockets and do not shift them with a future native clock step');
    assert.equal(result.react.commits, 2);
    assert.equal(result.cpu.functions[0].name, 'realOwner');
    assert.equal(result.attribution.mappedFrames, 1);
    assert.ok(!JSON.stringify(result).includes('never-save'));
  } finally { assert.equal((await capture.close()).asyncCallStackDepth, 0); }
  assert.equal(asyncDepthCommands.at(-1), 0);
});
