import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const review = {
  viewer: 'Alex', elapsedMs: 25,
  questions: { request_to_me: 'Request to me' },
  rows: [{ message: { id: '1', sender: 'Jamie', text: 'Alex, send the file?', sourceIndex: 0 }, category: 'flagged', needsReview: false, scores: { request_to_me: .9 }, reviewReasons: [] }]
};

async function browserHarness() {
  class Element {
    constructor() { this.value = ''; this.children = []; this.listeners = {}; this.hidden = false; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    scrollIntoView() {}
  }
  const elements = new Map();
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  element('filter').value = 'active';
  element('viewer').value = 'Alex';
  element('conversation').value = 'Alex: Hello';
  const responses = [];
  const reply = data => ({ ok: true, json: async () => data });
  runInNewContext(script, {
    document: { getElementById: element, createElement: () => new Element() },
    fetch: async path => {
      if (path === '/api/status') return reply({ modelLoaded: true, busy: false, phase: 'ready', device: 'cpu' });
      if (path === '/sample.json') return { ok: true, text: async () => '{"messages":[{"sender":"Alex","text":"Sample"}]}' };
      if (path === '/api/analyze') return await responses.shift()();
      throw new Error(`Unexpected test URL: ${path}`);
    },
    crypto: webcrypto, TextEncoder, setInterval: () => 1, clearInterval() {},
    localStorage: { getItem: () => null, setItem() {} }
  });
  await new Promise(resolve => setImmediate(resolve));
  return { element, responses, reply, click: id => element(id).listeners.click(), input: id => element(id).listeners.input(), change: (id, event) => element(id).listeners.change(event) };
}

test('starting another analysis clears prior cards and disables export even if it fails', async () => {
  const ui = await browserHarness();
  ui.responses.push(() => ui.reply(review));
  await ui.click('analyze');
  assert.equal(ui.element('results-section').hidden, false);
  assert.equal(ui.element('empty-review').hidden, true);
  assert.equal(ui.element('export').disabled, false);
  ui.responses.push(() => ({ ok: false, json: async () => ({ error: 'Model unavailable' }) }));
  await ui.click('analyze');
  assert.equal(ui.element('results-section').hidden, true);
  assert.equal(ui.element('empty-review').hidden, false);
  assert.equal(ui.element('results').children.length, 0);
  assert.equal(ui.element('source').children.length, 0);
  assert.equal(ui.element('export').disabled, true);
  assert.equal(ui.element('error').textContent, 'Model unavailable');
});

test('editing inputs and importing a sample or file clears the previous review', async () => {
  const ui = await browserHarness();
  for (const id of ['conversation', 'viewer', 'context']) {
    ui.responses.push(() => ui.reply(review));
    await ui.click('analyze');
    ui.input(id);
    assert.equal(ui.element('results-section').hidden, true);
    assert.equal(ui.element('export').disabled, true);
  }
  ui.responses.push(() => ui.reply(review));
  await ui.click('analyze');
  await ui.click('sample');
  assert.equal(ui.element('results-section').hidden, true);
  assert.equal(ui.element('empty-review').hidden, false);
  assert.equal(ui.element('export').disabled, true);
  ui.responses.push(() => ui.reply(review));
  await ui.click('analyze');
  await ui.change('file', { target: { files: [{ name: 'new-conversation.json', size: 45, text: async () => '[{"sender":"Alex","text":"New conversation"}]' }] } });
  assert.equal(ui.element('results-section').hidden, true);
  assert.equal(ui.element('export').disabled, true);
});

test('a late analysis response cannot restore cards after the input changes', async () => {
  const ui = await browserHarness();
  let resolveResponse;
  ui.responses.push(() => new Promise(resolve => { resolveResponse = resolve; }));
  const pending = ui.click('analyze');
  ui.input('conversation');
  resolveResponse(ui.reply(review));
  await pending;
  assert.equal(ui.element('results-section').hidden, true);
  assert.equal(ui.element('export').disabled, true);
  assert.match(ui.element('status').textContent, /input changed during analysis/);
});
