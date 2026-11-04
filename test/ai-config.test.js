// test/ai-config.test.js: which AI provider the .env settings select. Uses configFromEnv
// with a plain object, so it never reads your real .env.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { configFromEnv, aiIsConfigured } = require('../src/main/ai-config');

const from = (obj) => configFromEnv((name) => (obj[name] || '').trim());

test('Gemini key set: Gemini wins, even if Cloudflare is also configured', () => {
  const c = from({ GEMINI_API_KEY: 'g', AI_API_KEY: 'c', AI_ACCOUNT_ID: 'a' });
  assert.strictEqual(c.provider, 'gemini');
  assert.strictEqual(c.apiKey, 'g');
  assert.strictEqual(aiIsConfigured(c), true);
});

test('Gemini model chain: default, custom, and tidy parsing', () => {
  assert.deepStrictEqual(from({ GEMINI_API_KEY: 'g' }).models, ['gemini-3.5-flash', 'gemini-3.5-flash-lite']);
  assert.deepStrictEqual(from({ GEMINI_API_KEY: 'g', GEMINI_MODELS: ' x , y ,,z ' }).models, ['x', 'y', 'z']);
  assert.deepStrictEqual(from({ GEMINI_API_KEY: 'g', GEMINI_MODELS: ' , ' }).models, ['gemini-3.5-flash', 'gemini-3.5-flash-lite']);
  assert.strictEqual(from({ GEMINI_API_KEY: 'g' }).thinking, undefined);
  assert.strictEqual(from({ GEMINI_API_KEY: 'g', GEMINI_THINKING: 'low' }).thinking, 'low');
});

test('no Gemini key: Cloudflare when both of its values are set', () => {
  const c = from({ AI_API_KEY: 'c', AI_ACCOUNT_ID: 'a', AI_MODEL: '@cf/x' });
  assert.deepStrictEqual(c, { provider: 'cloudflare', apiKey: 'c', accountId: 'a', model: '@cf/x' });
  assert.strictEqual(aiIsConfigured(c), true);
});

test('half-configured Cloudflare, or nothing: no AI', () => {
  for (const env of [{}, { AI_API_KEY: 'c' }, { AI_ACCOUNT_ID: 'a' }]) {
    const c = from(env);
    assert.strictEqual(c.provider, null);
    assert.strictEqual(aiIsConfigured(c), false);
  }
});
