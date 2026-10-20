import axios from 'axios';
import fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { installAxiosFastifyAdapter } from './axiosAdapter';

describe('axios fastify adapter helper', () => {
  let app: FastifyInstance | null = null;
  let restoreAdapter: (() => void) | null = null;

  afterEach(async () => {
    restoreAdapter?.();
    restoreAdapter = null;
    if (app) {
      await app.close().catch(() => {});
      app = null;
    }
  });

  it('adapts fastify responses for axios and preserves error codes', async () => {
    app = fastify({ logger: false });
    app.get('/boom', async (_req, reply) => reply.code(418).send({ error: 'teapot' }));
    await app.ready();

    restoreAdapter = installAxiosFastifyAdapter({
      app,
      origin: 'http://adapter.test',
    });

    await expect(axios.get('http://adapter.test/boom')).rejects.toMatchObject({
      name: 'AxiosError',
      isAxiosError: true,
      code: 'ERR_BAD_REQUEST',
      response: expect.objectContaining({ status: 418 }),
    });
  });

  it('preserves Axios query serialization and the JSON request/response boundary', async () => {
    app = fastify({ logger: false });
    app.post('/inspect', async request => ({ url: request.url, body: request.body,
      authorization: request.headers.authorization }));
    await app.ready();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });
    const config = { baseURL: 'http://adapter.test', url: '/inspect?existing=one', method: 'post',
      params: { tag: ['a b', 'c+d'], absent: undefined },
      headers: { authorization: 'Bearer fixture' }, data: { revision: 2 } };
    const response = await axios.request(config);

    expect(response.data).toEqual({ url: axios.getUri(config).replace(config.baseURL, ''),
      body: config.data, authorization: config.headers.authorization });
  });

  it('accepts error responses when Axios status validation is explicitly disabled', async () => {
    app = fastify({ logger: false });
    app.get('/unavailable', async (_request, reply) => reply.code(503).send({ error: 'unavailable' }));
    await app.ready();
    const originalAdapter = axios.defaults.adapter;
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    const response = await axios.get('http://adapter.test/unavailable', { validateStatus: null });
    expect(response.status).toBe(503);
    expect(response.data).toEqual({ error: 'unavailable' });
    restoreAdapter();
    restoreAdapter = null;
    expect(axios.defaults.adapter).toBe(originalAdapter);
  });

  it('rejects server failures by default and refuses another origin before its handler runs', async () => {
    let effects = 0;
    app = fastify({ logger: false });
    app.post('/effect', async (_request, reply) => { effects += 1; return reply.code(503).send({ error: 'unavailable' }); });
    await app.ready();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'http://adapter.test' });

    await expect(axios.post('http://other.test/effect', {})).rejects.toThrow('unexpected origin');
    expect(effects).toBe(0);
    await expect(axios.post('http://adapter.test/effect', {})).rejects.toMatchObject({
      name: 'AxiosError', code: 'ERR_BAD_RESPONSE', response: { status: 503, data: { error: 'unavailable' } },
    });
    expect(effects).toBe(1);
  });
});
