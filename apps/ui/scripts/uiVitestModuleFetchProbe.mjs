// Temporary lane instrumentation. Records paths and numeric resource data, never source or argv.
import os from 'node:os';
import fs from 'node:fs';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { ViteNodeServer } from 'vite-node/server';

const start = performance.now();
const lag = monitorEventLoopDelay({ resolution: 20 });
lag.enable();
const servers = [];
const state = new WeakMap();
let peakRss = 0;
let peakLoad = 0;
let minFree = os.freemem();
const sample = () => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
  peakLoad = Math.max(peakLoad, os.loadavg()[0]);
  minFree = Math.min(minFree, os.freemem());
};
const timer = setInterval(sample, 1000);
timer.unref();
function get(server) {
  if (!state.has(server)) {
    const value = { fetches: 0, initialCache: server.fetchCache.size, hits: 0, inflight: 0, peakInflight: 0, maxFetchMs: 0, transforms: new Map() };
    state.set(server, value);
    servers.push(server);
  }
  return state.get(server);
}
const fetch = ViteNodeServer.prototype.fetchResult;
ViteNodeServer.prototype.fetchResult = async function (id, ...args) {
  const s = get(this);
  s.fetches++;
  if (this.fetchCache.has(id)) s.hits++;
  s.inflight++;
  s.peakInflight = Math.max(s.peakInflight, s.inflight);
  const at = performance.now();
  try { return await fetch.call(this, id, ...args); }
  finally { s.inflight--; s.maxFetchMs = Math.max(s.maxFetchMs, performance.now() - at); }
};
const transform = ViteNodeServer.prototype._transformRequest;
ViteNodeServer.prototype._transformRequest = async function (id, ...args) {
  const s = get(this);
  const at = performance.now();
  try { return await transform.call(this, id, ...args); }
  finally { s.transforms.set(id, (s.transforms.get(id) ?? 0) + performance.now() - at); }
};
process.once('exit', () => {
  clearInterval(timer); sample(); lag.disable();
  if (!servers.length) return;
  const summaries = servers.map(server => {
    const s = get(server);
    const nodes = [...server.server.moduleGraph.idToModuleMap.values()];
    const graph = nodes.filter(n => /\.(?:test|spec)\.[jt]sx?$/.test(n.id ?? '')).map(root => {
      const seen = new Set();
      const visit = n => {
        if (!n || seen.has(n.id)) return;
        seen.add(n.id);
        for (const dep of [...(n.ssrTransformResult?.deps ?? []), ...(n.ssrTransformResult?.dynamicDeps ?? [])]) {
          visit(server.server.moduleGraph.urlToModuleMap.get(dep) ?? server.server.moduleGraph.idToModuleMap.get(dep));
        }
      };
      visit(root);
      return { path: root.id, modules: seen.size, transformMs: [...seen].reduce((sum, id) => sum + (s.transforms.get(id) ?? 0), 0) };
    }).sort((a,b) => b.modules-a.modules).slice(0,20);
    const roots = nodes.filter(n => /(?:dev\/testkit\/index|dev\/vitestSetup|sync\/store\/hooks|pluginUiPrivatePresentationHost)\.[jt]sx?$/.test(n.id ?? '')).map(root => {
      const seen = new Set();
      const visit = n => { if (!n || seen.has(n.id)) return; seen.add(n.id); for (const dep of n.ssrTransformResult?.deps ?? []) visit(server.server.moduleGraph.urlToModuleMap.get(dep) ?? server.server.moduleGraph.idToModuleMap.get(dep)); };
      visit(root);
      return { path: root.id, modules: seen.size, dependencies: root.ssrTransformResult?.deps };
    });
    return { ...s, transforms: s.transforms.size, cacheSize: server.fetchCache.size, modules: nodes.length, transformMs: [...s.transforms.values()].reduce((a,b)=>a+b,0), topTransforms: [...s.transforms].sort((a,b)=>b[1]-a[1]).slice(0,20), graph, roots };
  });
  console.log('MODULE_FETCH_PROBE ' + JSON.stringify({ host: os.hostname(), pid: process.pid, cores: os.availableParallelism(), totalMem: os.totalmem(), minFree, peakRss, peakLoad, wallMs: performance.now()-start, cpu: process.cpuUsage(), lagMaxMs: lag.max/1e6, lagMeanMs: lag.mean/1e6, servers: summaries }));
});
