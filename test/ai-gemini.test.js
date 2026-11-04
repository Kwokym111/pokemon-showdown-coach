// test/ai-gemini.test.js: the Gemini provider. No network and no real key: a fake fetch
// stands in for Google, and a fake sleep makes retries instant.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { addExplanations, callGemini, DEFAULT_GEMINI_MODELS } = require('../src/main/ai');

const KEY = 'AIza-secret-key-123';
const PROMPT = { system: 'SYS', user: 'USER' };
const quiet = { warn() {}, log() {} };
const noWait = { sleep: async () => {} };

const gemOk = (text) => new Response(JSON.stringify({
  candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
}), { status: 200 });
const gemErr = (status, message = 'oops') => new Response(JSON.stringify({ error: { code: status, message } }), { status });

// A fake fetch that answers from a list (one answer per call; the last one repeats) and
// records every call. An answer can be a Response or a function (url, init) => Response.
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    const a = answers[Math.min(calls.length, answers.length - 1)];
    calls.push({ url, init, body: JSON.parse(init.body), model: /models\/([^:]+):/.exec(url)[1] });
    return typeof a === 'function' ? a(url, init) : a.clone();
  };
  fn.calls = calls;
  return fn;
}

const review = () => ({
  room: 'r', players: { me: 'me', opponent: 'them' }, result: { won: true, forfeit: false, lastTurn: 5 },
  aiUsed: false, summary: null,
  moments: [{ turn: 2, rule: 'x', label: 'good', mon: 'A', title: 'T', explanation: null, facts: {} }],
});
const goodJson = JSON.stringify({ summary: 'S', explanations: ['E'] });

test('sends a correct Gemini request: header key, JSON output, system + user text', async () => {
  const fetch = fakeFetch([gemOk('hello')]);
  const text = await callGemini(PROMPT, KEY, { fetch, models: ['m-1'], maxTokens: 700, baseUrl: 'https://g.test/v1beta' });
  assert.strictEqual(text, 'hello');
  const [c] = fetch.calls;
  assert.strictEqual(c.url, 'https://g.test/v1beta/models/m-1:generateContent');
  assert.strictEqual(c.init.method, 'POST');
  assert.strictEqual(c.init.headers['x-goog-api-key'], KEY);
  assert.ok(!c.url.includes(KEY), 'key is never in the URL');
  assert.strictEqual(c.body.systemInstruction.parts[0].text, 'SYS');
  assert.strictEqual(c.body.contents[0].parts[0].text, 'USER');
  assert.strictEqual(c.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(c.body.generationConfig.maxOutputTokens > 700, 'headroom for thinking tokens');
  assert.strictEqual(c.body.generationConfig.thinkingConfig, undefined, 'thinking only sent when set');
});

test('thinking level is sent only when given', async () => {
  const fetch = fakeFetch([gemOk('x')]);
  await callGemini(PROMPT, KEY, { fetch, models: ['m'], thinking: 'low' });
  assert.deepStrictEqual(fetch.calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

test('uses the default chain when none is given, and skips "thought" parts', async () => {
  const fetch = fakeFetch([new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'hidden', thought: true }, { text: 'vis' }, { text: 'ible' }] } }],
  }))]);
  assert.strictEqual(await callGemini(PROMPT, KEY, { fetch }), 'visible');
  assert.strictEqual(fetch.calls[0].model, DEFAULT_GEMINI_MODELS[0]);
});

test('a busy model (503) is retried once on the same model', async () => {
  const fetch = fakeFetch([gemErr(503), gemOk('ok')]);
  assert.strictEqual(await callGemini(PROMPT, KEY, { fetch, models: ['a', 'b'], ...noWait }), 'ok');
  assert.deepStrictEqual(fetch.calls.map((c) => c.model), ['a', 'a']);
});

test('a model that keeps failing hands over to the next model', async () => {
  const fetch = fakeFetch([gemErr(503), gemErr(429), gemOk('from b')]);
  assert.strictEqual(await callGemini(PROMPT, KEY, { fetch, models: ['a', 'b'], ...noWait }), 'from b');
  assert.deepStrictEqual(fetch.calls.map((c) => c.model), ['a', 'a', 'b']);
});

test('404 (unknown model) moves on without retrying', async () => {
  const fetch = fakeFetch([gemErr(404, 'model not found'), gemOk('from b')]);
  assert.strictEqual(await callGemini(PROMPT, KEY, { fetch, models: ['a', 'b'], ...noWait }), 'from b');
  assert.deepStrictEqual(fetch.calls.map((c) => c.model), ['a', 'b']);
});

test('a bad key (401, or Google\'s 400 "API key not valid") stops the whole chain', async () => {
  for (const answer of [gemErr(401, 'nope'), gemErr(403, 'denied'), gemErr(400, 'API key not valid. Please pass a valid API key.')]) {
    const fetch = fakeFetch([answer]);
    await assert.rejects(callGemini(PROMPT, KEY, { fetch, models: ['a', 'b'], ...noWait }), /Gemini failed/);
    assert.strictEqual(fetch.calls.length, 1, 'no point trying more models with a bad key');
  }
});

test('empty reply, blocked prompt and MAX_TOKENS are failures that fall through the chain', async () => {
  const bad = [
    new Response(JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] })),
    new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })),
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"summ' }] }, finishReason: 'MAX_TOKENS' }] })),
  ];
  for (const b of bad) {
    const fetch = fakeFetch([b, gemOk('second')]);
    assert.strictEqual(await callGemini(PROMPT, KEY, { fetch, models: ['a', 'b'], ...noWait }), 'second');
    assert.deepStrictEqual(fetch.calls.map((c) => c.model), ['a', 'b']);
  }
});

test('all models failing throws one summary error', async () => {
  const fetch = fakeFetch([gemErr(503, 'high demand')]);
  await assert.rejects(
    callGemini(PROMPT, KEY, { fetch, models: ['a', 'b'], ...noWait }),
    /Gemini failed: a: HTTP 503: high demand; b: HTTP 503: high demand/,
  );
});

test('the whole chain fits the timeout, even when every call hangs', async () => {
  // A fetch that never answers on its own: it only ends when its abort signal fires.
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
  });
  const started = Date.now();
  await assert.rejects(callGemini(PROMPT, KEY, { fetch: hang, models: ['a', 'b'], timeoutMs: 400, ...noWait }), /Gemini failed/);
  assert.ok(Date.now() - started < 400 + 250, `took ${Date.now() - started} ms`);
});

test('a hanging first model does not starve the second one', async () => {
  const fetch = fakeFetch([
    (_u, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))),
    gemOk('from b'),
  ]);
  assert.strictEqual(await callGemini(PROMPT, KEY, { fetch, models: ['a', 'b'], timeoutMs: 600, ...noWait }), 'from b');
});

test('the key never appears in errors, even if Google echoes it back', async () => {
  const fetch = fakeFetch([gemErr(500, `bad request for key ${KEY}`)]);
  await assert.rejects(callGemini(PROMPT, KEY, { fetch, models: ['a'], ...noWait }), (err) => {
    assert.ok(!err.message.includes(KEY), err.message);
    return true;
  });
});

test('addExplanations works end to end with provider "gemini", and never logs the key', async () => {
  const fetch = fakeFetch([gemErr(503), gemOk(goodJson)]);
  const logged = [];
  const out = await addExplanations(review(), {
    provider: 'gemini', apiKey: ` ${KEY}\r\n`, models: ['a', 'b'], fetch, ...noWait, logger: { warn: (m) => logged.push(m) },
  });
  assert.strictEqual(out.aiUsed, true);
  assert.strictEqual(out.summary, 'S');
  assert.strictEqual(out.moments[0].explanation, 'E');
  assert.strictEqual(fetch.calls[0].init.headers['x-goog-api-key'], KEY, 'key is trimmed');
  assert.deepStrictEqual(logged, []);
});

test('addExplanations: every Gemini model failing gives the review back without AI', async () => {
  const fetch = fakeFetch([gemErr(503, `busy ${KEY}`)]);
  const logged = [];
  const input = review();
  const out = await addExplanations(input, {
    provider: 'gemini', apiKey: KEY, models: ['a', 'b'], fetch, ...noWait, logger: { warn: (m) => logged.push(m) },
  });
  assert.deepStrictEqual(out, review());
  assert.strictEqual(out.aiUsed, false);
  assert.ok(logged.length > 0 && logged.every((m) => !m.includes(KEY)), 'warned, without the key');
});

test('addExplanations without provider "gemini" does not touch Gemini', async () => {
  const fetch = fakeFetch([gemOk(goodJson)]);
  // No accountId, so the Cloudflare function fails safely instead of calling Gemini.
  const out = await addExplanations(review(), { apiKey: KEY, fetch, logger: quiet });
  assert.strictEqual(out.aiUsed, false);
  assert.strictEqual(fetch.calls.length, 0);
});

test('aiModel names the model of the chain that actually answered', async () => {
  const fetch = fakeFetch([gemErr(404, 'no such model'), gemOk(goodJson)]);
  const out = await addExplanations(review(), { provider: 'gemini', apiKey: KEY, models: ['first', 'second'], fetch, ...noWait, logger: quiet });
  assert.strictEqual(out.aiUsed, true);
  assert.strictEqual(out.aiModel, 'second');
});

test('aiModel is absent when the AI was not used, and the input review never gets it', async () => {
  const input = review();
  const out = await addExplanations(input, { provider: 'gemini', apiKey: KEY, models: ['a'], fetch: fakeFetch([gemErr(503)]), ...noWait, logger: quiet });
  assert.strictEqual('aiModel' in out, false);
  assert.strictEqual('aiModel' in input, false);
});

test('the system prompt carries the wording rules', () => {
  const { buildPrompt } = require('../src/main/ai');
  const { system } = buildPrompt(review());
  for (const needle of ['say "your <name>"', '4 means "4x damage"', '2 means "super effective"', '1 means "normal damage"', '0.5 means "resisted"', 'Never call a 1x option "safe"', '"safer"', '"from full health"', 'starting value is 100']) {
    assert.ok(system.includes(needle), `missing: ${needle}`);
  }
});
