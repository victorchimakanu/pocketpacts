import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConversation, validateAnalysis, buildState, mapDecision, analyzeMessages, QUESTIONS, LIMITS } from '../core.mjs';

const input = 'Alex: I will send the draft.\nJamie: Thanks.\nPlease include the title.';
const message = { id: 'a', sender: 'Alex', text: 'I will send it.', sourceIndex: 0, timestamp: '' };
const fullContext = { omittedMessages: 0, excerpts: 0, incomplete: false };
const decision = (values = [0.1, 0.9, 0.1, 0.1], usage = {}) => ({ model: 'test fixture', answers: Object.fromEntries(Object.keys(QUESTIONS).map((id, index) => [id, { noul: values[index] }])), usage });

test('plain text preserves sender, multiline source text, and input order', () => {
  const rows = parseConversation(input);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sender, 'Alex');
  assert.equal(rows[1].text, 'Thanks.\nPlease include the title.');
  assert.equal(rows[1].sourceIndex, 1);
});

test('JSON import accepts array and messages wrapper with stable source ids', () => {
  const array = [{ id: 2, sender: 'Alex', text: 'Hello', timestamp: '10:00' }];
  assert.deepEqual(parseConversation(JSON.stringify(array)), parseConversation(JSON.stringify({ messages: array })));
  assert.equal(parseConversation(JSON.stringify(array))[0].id, '2');
});

test('invalid input, duplicate ids, oversized messages, and empty senders fail before inference', () => {
  for (const bad of ['{bad', '{}', '[]', 'No sender', JSON.stringify([{ sender: '', text: 'x' }]), JSON.stringify([{ sender: 'a', text: 'x'.repeat(LIMITS.messageChars + 1) }]), JSON.stringify([{ id: 'a', sender: 'a', text: 'x' }, { id: 'a', sender: 'b', text: 'y' }])]) {
    assert.throws(() => parseConversation(bad));
  }
  assert.throws(() => parseConversation('x'.repeat(LIMITS.inputChars + 1)), /exceeds/);
  assert.throws(() => parseConversation(JSON.stringify(Array.from({ length: LIMITS.messages + 1 }, () => ({ sender: 'a', text: 'x' })))), /at most/);
});

test('viewer must match a real sender and context is bounded', () => {
  assert.equal(validateAnalysis({ viewer: 'alex', conversation: input }).viewer, 'alex');
  assert.throws(() => validateAnalysis({ viewer: 'Unknown', conversation: input }), /match a sender/);
  assert.throws(() => validateAnalysis({ viewer: 'Alex', conversation: input, context: 'x'.repeat(601) }), /exceeds/);
  assert.throws(() => validateAnalysis([]), /JSON object/);
  assert.throws(() => validateAnalysis({ viewer: 'Alex', conversation: input, typo: true }), /Unknown analysis field/);
});

test('state keeps full target and following replies, labels every omitted or clipped context', () => {
  const rows = parseConversation(JSON.stringify([{ sender: 'Alex', text: 'x'.repeat(700) }, { sender: 'Jamie', text: 'Sent and resolved.' }]));
  const first = buildState(rows, 0, 'Alex');
  assert.equal(first.state.target_message.text.length, 700);
  assert.equal(first.state.conversation_after[0].text, 'Sent and resolved.');
  assert.equal(first.context.incomplete, false);
  const second = buildState(rows, 1, 'Alex');
  assert.match(second.state.conversation_before[0].text, /excerpt cut/);
  assert.equal(second.context.excerpts, 1);
  assert.equal(second.context.incomplete, true);
  const longRows = Array.from({ length: 20 }, (_, index) => ({ ...message, id: String(index) }));
  assert.equal(buildState(longRows, 0, 'Alex').context.omittedMessages, 13);
});

test('probability mapping rejects missing, NaN, and out of range scores', () => {
  assert.throws(() => mapDecision({}, message, fullContext), /no answers/);
  for (const value of [undefined, NaN, 1.1, -0.1, '0.9']) assert.throws(() => mapDecision(decision([value, .1, .1, .1]), message, fullContext), /invalid probability/);
});

test('model truncation and midpoint scores always require review', () => {
  assert.equal(mapDecision(decision(), message, fullContext).category, 'flagged');
  assert.equal(mapDecision(decision([.1, .1, .1, .1]), message, fullContext).category, 'quiet');
  for (const usage of [{ truncated: true }, { stateTokensDropped: 10 }, { truncatedQuestions: ['reply_needed'] }]) {
    const row = mapDecision(decision(undefined, usage), message, fullContext);
    assert.equal(row.category, 'review');
    assert.match(row.reviewReasons[0], /truncated/);
  }
  assert.equal(mapDecision(decision([.1, .5, .1, .1]), message, fullContext).needsReview, true);
  assert.equal(mapDecision(decision(), message, { ...fullContext, incomplete: true }).needsReview, true);
});

test('analysis keeps source mapping and runs one real decision callback at a time', async () => {
  let active = 0;
  let highest = 0;
  const progress = [];
  const result = await analyzeMessages(validateAnalysis({ viewer: 'Alex', conversation: input }), async request => {
    active += 1;
    highest = Math.max(highest, active);
    assert.deepEqual(Object.keys(request.questions), Object.keys(QUESTIONS));
    await Promise.resolve();
    active -= 1;
    return decision();
  }, completed => progress.push(completed));
  assert.equal(highest, 1);
  assert.deepEqual(progress, [1, 2]);
  assert.equal(result.rows[1].message.text, 'Thanks.\nPlease include the title.');
});
