import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalServer, HttpError } from '../shared/http.mjs';
import { getSdk, errorDetails, resolveCachedModel } from '../shared/qvac.mjs';
import { analyzeMessages, validateAnalysis, InputError, LIMITS } from './core.mjs';

export function createPromiseRadar({ sdkProvider = getSdk, configuredModelPath = process.env.QVAC_LAYA_MODEL ?? '', modelSourceResolver = resolveCachedModel } = {}) {
  const state = { phase: 'idle', modelLoaded: false, modelPath: '', device: '', completed: 0, total: 0, downloadProgress: null, error: null };
  let sdk;
  let modelId;
  let busy = false;
  let activeRequestId;
  let stopRequested = false;

  function requireBody(body, allowed = []) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object.');
    const unknown = Object.keys(body).find(key => !allowed.includes(key));
    if (unknown) throw new HttpError(400, `Unknown request field: ${unknown}.`);
  }

  function checkStopped() {
    if (stopRequested) throw new HttpError(409, 'Operation stopped. No new result was saved.');
  }

  function clearModel() {
    modelId = undefined;
    state.modelLoaded = false;
    state.modelPath = '';
    state.device = '';
  }

  async function runExclusive(phase, action) {
    if (busy) throw new HttpError(409, 'PocketPacts is busy. Wait or stop the current operation.');
    busy = true;
    stopRequested = false;
    state.phase = phase;
    state.error = null;
    try { return await action(); }
    catch (error) {
      state.error = String(error.message ?? error);
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, state.error, errorDetails(error));
    } finally {
      busy = false;
      activeRequestId = undefined;
      state.phase = modelId ? 'ready' : 'idle';
      state.modelLoaded = Boolean(modelId);
    }
  }

  const routes = {
    'GET /api/status': async () => ({ ...state, configuredModelPath, busy, limits: LIMITS, sdkVersion: '0.22.0', engine: 'llamacpp-decision', catalogModel: 'LAYA_MULTILINGUAL_322M_Q8_0', catalogBytes: 348425664 }),
    'POST /api/load': async ({ body }) => {
      requireBody(body, ['modelPath', 'device']);
      if (body.modelPath !== undefined && typeof body.modelPath !== 'string') throw new HttpError(400, 'modelPath must be text.');
      const path = (body.modelPath ?? configuredModelPath).trim();
      if (path && (typeof path !== 'string' || !isAbsolute(path) || !path.toLowerCase().endsWith('.gguf'))) {
        throw new HttpError(400, 'A local override must be an absolute path to a Laya GGUF file. Leave it empty for the catalog model.');
      }
      const device = body.device === undefined ? 'cpu' : body.device;
      if (!['cpu', 'gpu'].includes(device)) throw new HttpError(400, 'Device must be cpu or gpu.');
      return runExclusive('loading', async () => {
      if (path) {
        let info;
        try { info = await stat(path); } catch { throw new HttpError(400, 'The model file could not be read. Check its absolute path.'); }
        if (!info.isFile() || info.size === 0) throw new HttpError(400, 'The model path must point to a nonempty file.');
      }
      checkStopped();
      sdk ??= await sdkProvider();
      checkStopped();
      if (modelId) {
        await sdk.unloadModel({ modelId });
        clearModel();
      }
      checkStopped();
      state.downloadProgress = null;
      const modelSrc = path || await modelSourceResolver(sdk.LAYA_MULTILINGUAL_322M_Q8_0);
      checkStopped();
      const call = sdk.loadModel({ modelSrc, modelType: 'llamacpp-decision', modelConfig: { device, batch_size: 2048 }, onProgress: progress => { state.downloadProgress = progress; } });
      activeRequestId = call.requestId;
      modelId = await call;
      activeRequestId = undefined;
      if (stopRequested) {
        await sdk.unloadModel({ modelId });
        clearModel();
        checkStopped();
      }
      state.modelPath = path || 'LAYA_MULTILINGUAL_322M_Q8_0';
      state.device = device;
      return { modelLoaded: true, modelPath: state.modelPath, requestedDevice: device, note: 'Requested device is a load preference. No backend speed claim is made.' };
      });
    },
    'POST /api/analyze': async ({ body }) => {
      let input;
      try { input = validateAnalysis(body); }
      catch (error) { if (error instanceof InputError) throw new HttpError(400, error.message); throw error; }
      if (!modelId) throw new HttpError(409, 'Load a Laya model first. No AI analysis has run.');
      return runExclusive('analyzing', async () => {
        state.completed = 0;
        state.total = input.messages.length;
        const started = performance.now();
        const result = await analyzeMessages(input, async request => {
          if (stopRequested) throw new HttpError(409, 'Analysis stopped. No partial result was saved.');
          const call = sdk.decide({ modelId, ...request, maxLen: 2048, headMaxLen: 256 });
          activeRequestId = call.requestId;
          const result = await call;
          activeRequestId = undefined;
          if (stopRequested) throw new HttpError(409, 'Analysis stopped. No partial result was saved.');
          return result;
        }, (completed, total) => { state.completed = completed; state.total = total; });
        return { ...result, mode: 'live', elapsedMs: Math.round(performance.now() - started), modelPath: state.modelPath, analyzedAt: new Date().toISOString() };
      });
    },
    'POST /api/cancel': async ({ body }) => {
      requireBody(body);
      if (!busy) return { stopped: false, message: 'No operation is running.' };
      stopRequested = true;
      if (activeRequestId) await sdk.cancel({ requestId: activeRequestId });
      return { stopped: true };
    },
    'POST /api/unload': async ({ body }) => {
      requireBody(body);
      return runExclusive('unloading', async () => {
      if (modelId) { await sdk.unloadModel({ modelId }); clearModel(); }
      return { modelLoaded: false };
      });
    }
  };

  return {
    routes,
    async close() {
      if (modelId) { await sdk.unloadModel({ modelId }); clearModel(); }
      if (sdk) await sdk.close();
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createPromiseRadar();
  const server = startLocalServer({ name: 'PocketPacts', port: 4321, publicDir: new URL('./public/', import.meta.url), routes: app.routes });
  const shutdown = async () => { server.close(); await app.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
