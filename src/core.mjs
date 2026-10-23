export const LIMITS = Object.freeze({ inputChars: 60_000, messages: 30, messageChars: 2_000, senderChars: 80, contextChars: 240, contextWindow: 6 });

export const QUESTIONS = Object.freeze({
  request_to_me: { type: 'noul', instructions: 'The target message asks the viewer to do something or provide information. Judge only the target message. Resolve who is speaking and who is being asked from the state. A request addressed only to someone else is false.' },
  promise_by_me: { type: 'noul', instructions: 'The target message is written by the viewer and contains a clear commitment by the viewer to do something. A request, suggestion, or a promise by someone else is false.' },
  blocker: { type: 'noul', instructions: 'The target message reports a problem or missing dependency that prevents work from moving forward. Judge only the target message in its surrounding conversation.' },
  reply_needed: { type: 'noul', instructions: 'At the end of this conversation, the viewer still needs to reply or act on the target message. Consider later messages. If a later message resolves the request, or the viewer has already answered it, this is false.' }
});

export const QUESTION_LABELS = Object.freeze({ request_to_me: 'Request to me', promise_by_me: 'Promise by me', blocker: 'Blocker', reply_needed: 'Reply or action needed' });

export class InputError extends Error {}

function boundedString(value, label, max, { optional = false } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim()) throw new InputError(`${label} must be nonempty text.`);
  const text = value.trim();
  if (text.length > max) throw new InputError(`${label} exceeds ${max} characters.`);
  return text;
}

function parsePlainText(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([^:\n]{1,80}):\s*(.+)$/);
    if (match) rows.push({ sender: match[1].trim(), text: match[2].trim() });
    else if (rows.length) rows.at(-1).text += `\n${line.trim()}`;
    else throw new InputError('Text must start with a sender and colon, such as Alex: Can you send the file?');
  }
  return rows;
}

export function parseConversation(input) {
  if (typeof input !== 'string' || !input.trim()) throw new InputError('Paste a conversation or import a JSON file.');
  if (input.length > LIMITS.inputChars) throw new InputError(`Conversation exceeds ${LIMITS.inputChars} characters.`);
  const text = input.trim();
  let parsed;
  if (text.startsWith('[') || text.startsWith('{')) {
    try { parsed = JSON.parse(text); } catch { throw new InputError('The JSON is invalid. Use a message array or an object with a messages array.'); }
  } else parsed = parsePlainText(text);
  const rows = Array.isArray(parsed) ? parsed : parsed?.messages;
  if (!Array.isArray(rows) || !rows.length) throw new InputError('The conversation needs at least one message.');
  if (rows.length > LIMITS.messages) throw new InputError(`Use at most ${LIMITS.messages} messages per analysis.`);
  const ids = new Set();
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new InputError(`Message ${index + 1} must be an object.`);
    const id = row.id === undefined ? `message-${index + 1}` : boundedString(String(row.id), `Message ${index + 1} id`, 120);
    if (ids.has(id)) throw new InputError(`Message ids must be unique. Duplicate: ${id}`);
    ids.add(id);
    return {
      id,
      sender: boundedString(row.sender, `Message ${index + 1} sender`, LIMITS.senderChars),
      text: boundedString(row.text, `Message ${index + 1} text`, LIMITS.messageChars),
      timestamp: boundedString(row.timestamp, `Message ${index + 1} timestamp`, 100, { optional: true }),
      sourceIndex: index
    };
  });
}

export function validateAnalysis(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('Send a JSON object.');
  const unknown = Object.keys(body).find(key => !['conversation', 'viewer', 'context'].includes(key));
  if (unknown) throw new InputError(`Unknown analysis field: ${unknown}.`);
  const messages = parseConversation(body.conversation);
  const viewer = boundedString(body.viewer, 'Your sender identity', LIMITS.senderChars);
  if (!messages.some(message => message.sender.toLocaleLowerCase() === viewer.toLocaleLowerCase())) {
    throw new InputError('Your sender identity must match a sender in this conversation.');
  }
  return { messages, viewer, context: boundedString(body.context, 'Thread context', 600, { optional: true }) };
}

function snippet(message) {
  const clipped = message.text.length > LIMITS.contextChars;
  return { sender: message.sender, text: clipped ? message.text.slice(0, LIMITS.contextChars) + ' [context excerpt cut]' : message.text, ...(clipped ? { excerpt: true } : {}) };
}

export function buildState(messages, index, viewer, context = '') {
  const before = messages.slice(Math.max(0, index - LIMITS.contextWindow), index);
  const after = messages.slice(index + 1, index + 1 + LIMITS.contextWindow);
  const omittedMessages = messages.length - 1 - before.length - after.length;
  const excerpts = [...before, ...after].filter(message => message.text.length > LIMITS.contextChars).length;
  return {
    state: {
      viewer,
      thread_context: context,
      conversation_before: before.map(snippet),
      target_message: { sender: messages[index].sender, text: messages[index].text },
      conversation_after: after.map(snippet),
      context_note: omittedMessages ? `${omittedMessages} messages outside this nearby context are omitted. Later resolutions outside this window may be missed.` : 'All conversation messages are included.'
    },
    context: { omittedMessages, excerpts, incomplete: omittedMessages > 0 || excerpts > 0 }
  };
}

export function mapDecision(result, message, context) {
  if (!result || typeof result !== 'object' || !result.answers) throw new Error('Laya returned no answers.');
  const scores = Object.fromEntries(Object.keys(QUESTIONS).map(id => {
    const probability = result.answers[id]?.noul;
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`Laya returned an invalid probability for ${id}.`);
    }
    return [id, probability];
  }));
  const usage = result.usage ?? {};
  const truncated = usage.truncated === true || Number(usage.stateTokensDropped) > 0 || (Array.isArray(usage.truncatedQuestions) ? usage.truncatedQuestions.length > 0 : Boolean(usage.truncatedQuestions));
  const ambiguous = Object.values(scores).some(value => value >= 0.35 && value <= 0.65);
  const needsReview = truncated || context.incomplete || ambiguous;
  return {
    message,
    scores,
    category: needsReview ? 'review' : Object.values(scores).some(value => value > 0.65) ? 'flagged' : 'quiet',
    needsReview,
    reviewReasons: [truncated && 'The model truncated its input.', context.incomplete && 'Nearby context is incomplete.', ambiguous && 'At least one score is near the middle.'].filter(Boolean),
    context,
    usage,
    model: result.model ?? null
  };
}

export async function analyzeMessages({ messages, viewer, context }, decide, onProgress = () => {}) {
  const rows = [];
  for (let index = 0; index < messages.length; index++) {
    const prepared = buildState(messages, index, viewer, context);
    const decision = await decide({ state: prepared.state, questions: QUESTIONS });
    rows.push(mapDecision(decision, messages[index], prepared.context));
    onProgress(index + 1, messages.length);
  }
  return { viewer, rows, questions: QUESTION_LABELS, thresholds: { low: 0.35, high: 0.65 }, caveat: 'Scores are model probabilities, not measured accuracy. Review thresholds are UI defaults and need testing on your own conversations.' };
}
