import { installWebCryptoWorker, type WebCryptoWorkerPort } from './webCryptoWorkerRuntime';

// This module is a Metro Worker entry, whose global is DedicatedWorkerGlobalScope.
// Keep the worker DOM boundary local instead of adding WebWorker libs to the app.
installWebCryptoWorker(globalThis as unknown as WebCryptoWorkerPort);
