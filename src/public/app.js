const $ = id => document.getElementById(id);
let result;
let fingerprint = '';
let dismissed = new Set();
let modelLoaded = false;
let localBusy = false;
let serverBusy = false;
let storageAvailable = true;
let inputRevision = 0;

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function showError(error) {
  $('error').textContent = error.message || String(error);
  $('error').hidden = false;
}

function clearError() { $('error').hidden = true; $('error').textContent = ''; }

function clearReview() {
  inputRevision += 1;
  result = undefined;
  fingerprint = '';
  dismissed = new Set();
  $('results-section').hidden = true;
  $('empty-review').hidden = false;
  $('results').replaceChildren();
  $('source').replaceChildren();
  $('source-section').open = false;
  $('run-info').textContent = '';
  $('counts').textContent = '';
  $('export').disabled = true;
  $('restore').disabled = true;
  return inputRevision;
}

function updateControls() {
  const busy = localBusy || serverBusy;
  $('load').disabled = busy;
  $('unload').disabled = busy || !modelLoaded;
  $('analyze').disabled = busy || !modelLoaded;
  $('stop').disabled = !busy;
  for (const id of ['model-path', 'device', 'viewer', 'context', 'conversation', 'sample', 'file']) $(id).disabled = busy;
}

async function refreshStatus() {
  const data = await api('/api/status');
  modelLoaded = data.modelLoaded;
  serverBusy = data.busy;
  if (!$('model-path').value && data.configuredModelPath) $('model-path').value = data.configuredModelPath;
  const progress = data.downloadProgress?.percentage;
  $('model-status').textContent = data.phase === 'loading' ? `Downloading / loading Laya${typeof progress === 'number' ? `: ${progress.toFixed(1)}%` : '…'}` : data.modelLoaded ? `Ready to review. Requested device: ${data.device.toUpperCase()}.` : 'Load Laya when you’re ready. First download: about 348 MB.';
  if (data.phase === 'analyzing') $('status').textContent = `Laya analysis: ${data.completed} of ${data.total} messages complete. Four questions per message.`;
  updateControls();
  return data;
}

async function perform(action) {
  clearError();
  localBusy = true;
  updateControls();
  const poll = setInterval(() => refreshStatus().catch(() => {}), 1200);
  try { await action(); }
  catch (error) { showError(error); $('status').textContent = 'The operation did not complete. No new result was saved.'; }
  finally { clearInterval(poll); localBusy = false; await refreshStatus().catch(showError); }
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value;
  if (className) element.className = className;
  return element;
}

function saveDismissed() {
  try { localStorage.setItem(`promise-radar:dismissed:${fingerprint}`, JSON.stringify([...dismissed])); }
  catch { storageAvailable = false; showError(new Error('This browser could not save review choices. They will last only until this page closes.')); }
}

function render() {
  if (!result) return;
  $('results-section').hidden = false;
  $('empty-review').hidden = true;
  $('export').disabled = false;
  $('restore').disabled = dismissed.size === 0;
  $('results').replaceChildren();
  const filter = $('filter').value;
  const rows = result.rows.filter(row => {
    const isDismissed = dismissed.has(row.message.id);
    if (filter === 'dismissed') return isDismissed;
    if (filter === 'all') return true;
    if (isDismissed) return false;
    if (filter === 'active') return row.category !== 'quiet';
    return row.category === filter;
  });
  const reviewCount = result.rows.filter(row => row.needsReview && !dismissed.has(row.message.id)).length;
  $('counts').textContent = `${rows.length} shown · ${reviewCount} need review · ${dismissed.size} dismissed. ${storageAvailable ? 'Dismissed ids stay in this browser.' : 'Review choices are temporary.'}`;
  for (const row of rows) {
    const card = document.createElement('article');
    card.className = 'card';
    card.append(text('h3', `${row.message.sender}${row.message.timestamp ? ` · ${row.message.timestamp}` : ''}`));
    card.append(text('span', dismissed.has(row.message.id) ? 'Dismissed by you' : row.category === 'review' ? 'Needs review' : row.category === 'flagged' ? 'Flagged candidate' : 'No strong signal', `badge badge-${row.category}`));
    card.append(text('blockquote', row.message.text));
    const scores = document.createElement('div');
    scores.className = 'scores';
    for (const [id, probability] of Object.entries(row.scores)) {
      const score = document.createElement('p');
      score.append(text('span', result.questions[id]), text('strong', `${(probability * 100).toFixed(1)}%`));
      scores.append(score);
    }
    card.append(scores);
    for (const reason of row.reviewReasons) card.append(text('p', reason, 'review'));
    const actions = document.createElement('div');
    actions.className = 'actions';
    const link = text('a', 'View original message');
    link.href = `#source-${row.message.sourceIndex}`;
    link.addEventListener('click', () => { $('source-section').open = true; });
    const button = text('button', dismissed.has(row.message.id) ? 'Restore' : 'Dismiss');
    button.addEventListener('click', () => {
      if (dismissed.has(row.message.id)) dismissed.delete(row.message.id); else dismissed.add(row.message.id);
      saveDismissed();
      render();
    });
    actions.append(link, button);
    card.append(actions);
    $('results').append(card);
  }
  if (!rows.length) $('results').append(text('p', 'No messages in this view. Choose All messages to inspect every score and source.'));
}

$('load').addEventListener('click', () => perform(async () => {
  $('status').textContent = 'Downloading / loading Laya. The first catalog load needs about 348 MB.';
  await api('/api/load', { modelPath: $('model-path').value.trim(), device: $('device').value });
  $('status').textContent = 'Laya is ready. Import a conversation to begin.';
}));

$('unload').addEventListener('click', () => perform(async () => {
  await api('/api/unload', {});
  $('status').textContent = 'Model unloaded. Existing review results remain on this page.';
}));

$('sample').addEventListener('click', async () => {
  try {
    clearError();
    const response = await fetch('/sample.json');
    if (!response.ok) throw new Error('Could not load the synthetic sample.');
    const input = await response.text();
    clearReview();
    $('conversation').value = input;
    $('viewer').value = 'Alex';
    $('context').value = 'The team is preparing a Friday demo. Alex is the viewer.';
    $('input-label').textContent = 'Synthetic sample loaded. Analysis will use the real local model.';
    $('status').textContent = modelLoaded ? 'Synthetic sample ready. Review it with the real local model.' : 'Synthetic sample ready. Load Laya to review it.';
  } catch (error) { showError(error); }
});

$('file').addEventListener('change', async event => {
  try {
    clearError();
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 240_000) throw new Error('Use a JSON file smaller than 240 KB and at most 60,000 characters.');
    const input = await file.text();
    if (input.length > 60_000) throw new Error('The conversation exceeds 60,000 characters.');
    JSON.parse(input);
    clearReview();
    $('conversation').value = input;
    $('input-label').textContent = `Imported ${file.name}. This data stays in the local app.`;
    $('status').textContent = modelLoaded ? 'Conversation imported. You’re ready to review.' : 'Conversation imported. Load Laya to review it.';
  } catch (error) { showError(error); }
});

$('analyze').addEventListener('click', () => perform(async () => {
  const revision = clearReview();
  $('status').textContent = 'Starting real Laya analysis…';
  const nextResult = await api('/api/analyze', { conversation: $('conversation').value, viewer: $('viewer').value.trim(), context: $('context').value.trim() });
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ viewer: nextResult.viewer, messages: nextResult.rows.map(row => row.message) })));
  if (revision !== inputRevision) {
    $('status').textContent = 'The input changed during analysis. Analyze again to get a new review.';
    return;
  }
  fingerprint = [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, '0')).join('');
  result = nextResult;
  try { dismissed = new Set(JSON.parse(localStorage.getItem(`promise-radar:dismissed:${fingerprint}`) || '[]')); }
  catch { dismissed = new Set(); storageAvailable = false; }
  $('run-info').textContent = `Live local analysis · ${result.rows.length} messages · ${(result.elapsedMs / 1000).toFixed(1)} seconds · viewer: ${result.viewer}`;
  $('source').replaceChildren(...result.rows.map(row => {
    const item = text('li', `${row.message.sender}${row.message.timestamp ? ` (${row.message.timestamp})` : ''}: ${row.message.text}`);
    item.id = `source-${row.message.sourceIndex}`;
    return item;
  }));
  $('filter').value = 'active';
  render();
  $('status').textContent = 'Analysis complete. Review the scores and the source before acting.';
  $('results-section').scrollIntoView({ behavior: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}));

$('stop').addEventListener('click', async () => {
  try { await api('/api/cancel', {}); $('status').textContent = 'Stop requested. Waiting for the local model to settle…'; }
  catch (error) { showError(error); }
});

$('filter').addEventListener('change', render);
for (const id of ['conversation', 'viewer', 'context']) $(id).addEventListener('input', () => {
  const hadResult = Boolean(result);
  clearReview();
  if (hadResult) $('status').textContent = 'Input changed. Review the conversation again for fresh results.';
});
$('restore').addEventListener('click', () => { dismissed.clear(); saveDismissed(); render(); });
$('export').addEventListener('click', () => {
  if (!result) return;
  const blob = new Blob([JSON.stringify({ ...result, dismissedMessageIds: [...dismissed] }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'pocketpacts-review.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

refreshStatus().catch(showError);
