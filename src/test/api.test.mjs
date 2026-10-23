import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createLocalServer } from '../../shared/http.mjs';
import { createPromiseRadar } from '../server.mjs';
import { QUESTIONS } from '../core.mjs';

const conversation = JSON.stringify([{ sender: 'Alex', text: 'I will send the file.' }, { sender: 'Jamie', text: 'Thank you.' }]);
const answer = { model: 'simulated unit test result', answers: Object.fromEntries(Object.keys(QUESTIONS).map(id => [id, { noul: .8 }])), usage: { truncated: false, truncatedQuestions: [], stateTokensDropped: 0 } };

async function harness(t, sdk, options = {}) {
  const app = createPromiseRadar({ sdkProvider: async () => sdk, configuredModelPath: '', ...options });
  const server = createLocalServer({ name: 'PocketPacts API test', publicDir: new URL('../public/', import.meta.url), routes: app.routes });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await app.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, body) => {
    const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
}

test('API requires a model and valid input before it can report live results', async t => {
  const calls = [];
  const sdk = {
    LAYA_MULTILINGUAL_322M_Q8_0: { name: 'catalog test descriptor' },
    async loadModel(input) { calls.push(['load', input]); return 'test-model'; },
    async decide(input) { calls.push(['decide', input]); return answer; },
    async unloadModel() { calls.push(['unload']); },
    async close() {}
  };
  const request = await harness(t, sdk);
  assert.equal((await request('/api/status')).data.modelLoaded, false);
  assert.equal(calls.length, 0);
  assert.equal((await request('/api/analyze', { viewer: 'Alex', conversation })).status, 409);
  assert.equal((await request('/api/load', { modelPath: 'relative.gguf' })).status, 400);
  assert.equal((await request('/api/load', { device: 'other' })).status, 400);
  assert.equal((await request('/api/load', {})).status, 200);
  assert.equal(calls[0][1].modelType, 'llamacpp-decision');
  assert.equal(calls[0][1].modelConfig.batch_size, 2048);
  assert.deepEqual(calls[0][1].modelSrc, sdk.LAYA_MULTILINGUAL_322M_Q8_0);
  assert.equal((await request('/api/analyze', { viewer: 'Wrong', conversation })).status, 400);
  const result = await request('/api/analyze', { viewer: 'Alex', conversation });
  assert.equal(result.status, 200);
  assert.equal(result.data.mode, 'live');
  assert.equal(result.data.rows.length, 2);
  assert.equal(calls.filter(([type]) => type === 'decide').length, 2);
  assert.equal(calls.find(([type]) => type === 'decide')[1].maxLen, 2048);
  assert.equal((await request('/api/unload', {})).data.modelLoaded, false);
  assert.equal((await request('/api/status')).data.modelLoaded, false);
});

test('API excludes concurrent analyses and honors a stop between messages', async t => {
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const sdk = {
    LAYA_MULTILINGUAL_322M_Q8_0: {},
    async loadModel() { return 'test-model'; },
    async decide() { started(); await pending; return answer; },
    async unloadModel() {}, async close() {}, async cancel() {}
  };
  const request = await harness(t, sdk);
  await request('/api/load', {});
  const first = request('/api/analyze', { viewer: 'Alex', conversation });
  await entered;
  assert.equal((await request('/api/analyze', { viewer: 'Alex', conversation })).status, 409);
  assert.equal((await request('/api/cancel', {})).data.stopped, true);
  release();
  const stopped = await first;
  assert.equal(stopped.status, 409);
  assert.match(stopped.data.error, /stopped/);
  assert.equal((await request('/api/status')).data.busy, false);
});

test('malformed load bodies and unknown fields never initialize the SDK', async t => {
  let initialized = 0;
  const sdk = { loadModel() { initialized++; throw new Error('Must not run'); }, async close() {} };
  const request = await harness(t, sdk);
  for (const body of [null, [], 'model', 1, true, { modelPath: false }, { modelPath: null }, { device: null }, { model: 'typo' }]) {
    assert.equal((await request('/api/load', body)).status, 400);
  }
  for (const path of ['/api/cancel', '/api/unload']) {
    assert.equal((await request(path, null)).status, 400);
    assert.equal((await request(path, { typo: true })).status, 400);
  }
  assert.equal(initialized, 0);
  assert.equal((await request('/api/status')).data.busy, false);
});

test('a late successful load after cancellation is unloaded before returning', async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const unloaded = [];
  const sdk = {
    LAYA_MULTILINGUAL_322M_Q8_0: {},
    loadModel() { entered(); return pending; },
    async unloadModel({ modelId }) { unloaded.push(modelId); },
    async close() {}, async cancel() {}
  };
  const request = await harness(t, sdk);
  const load = request('/api/load', {});
  await started;
  assert.equal((await request('/api/cancel', {})).data.stopped, true);
  release('model-loaded-after-stop');
  assert.equal((await load).status, 409);
  assert.deepEqual(unloaded, ['model-loaded-after-stop']);
  const status = (await request('/api/status')).data;
  assert.equal(status.modelLoaded, false);
  assert.equal(status.modelPath, '');
  assert.equal(status.busy, false);
});

test('load failures release the busy state so a later load can succeed', async t => {
  let attempts = 0;
  const sdk = {
    LAYA_MULTILINGUAL_322M_Q8_0: {},
    async loadModel() { if (++attempts === 1) throw new Error('Simulated download failure'); return 'recovered'; },
    async unloadModel() {}, async close() {}
  };
  const request = await harness(t, sdk);
  assert.equal((await request('/api/load', {})).status, 503);
  assert.equal((await request('/api/status')).data.busy, false);
  assert.equal((await request('/api/load', {})).status, 200);
  const status = (await request('/api/status')).data;
  assert.equal(status.modelLoaded, true);
  assert.equal(status.error, null);
});

test('catalog loads use the verified local cache source supplied by the shared resolver', async t => {
  const descriptor = { name: 'test Laya catalog entry' };
  let loadedSource;
  const sdk = {
    LAYA_MULTILINGUAL_322M_Q8_0: descriptor,
    async loadModel({ modelSrc }) { loadedSource = modelSrc; return 'cached-model'; },
    async unloadModel() {}, async close() {}
  };
  const request = await harness(t, sdk, { modelSourceResolver: async source => {
    assert.equal(source, descriptor);
    return '/verified/test-cache/laya.gguf';
  } });
  assert.equal((await request('/api/load', {})).status, 200);
  assert.equal(loadedSource, '/verified/test-cache/laya.gguf');
});
