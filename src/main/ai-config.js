// ai-config.js: reads the AI settings from the .env file in the project root.
// Main process only (rule 5): the key is returned to main.js and passed straight to ai.js.
// It is never sent to a page and never logged.

const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');

const ENV_FILE = path.join(__dirname, '..', '..', '.env');

// The default model chain lives next to the code that uses it.
const { DEFAULT_GEMINI_MODELS } = require('./ai');

// Pure part, so tests can check the provider priority without touching the real .env.
// `get(name)` returns the trimmed value of a setting, or '' if it is not set.
//   1. GEMINI_API_KEY set            -> Google Gemini
//   2. AI_API_KEY + AI_ACCOUNT_ID    -> Cloudflare Workers AI
//   3. otherwise                     -> provider null (no AI, the review shows without words)
function configFromEnv(get) {
  const geminiKey = get('GEMINI_API_KEY');
  if (geminiKey) {
    const models = get('GEMINI_MODELS').split(',').map((m) => m.trim()).filter(Boolean);
    return {
      provider: 'gemini',
      apiKey: geminiKey,
      models: models.length ? models : DEFAULT_GEMINI_MODELS.slice(),
      thinking: get('GEMINI_THINKING') || undefined, // undefined = let the model decide
    };
  }
  const apiKey = get('AI_API_KEY');
  const accountId = get('AI_ACCOUNT_ID');
  if (apiKey && accountId) {
    return {
      provider: 'cloudflare',
      apiKey,
      accountId,
      model: get('AI_MODEL') || undefined, // undefined = the default model in ai.js
    };
  }
  return { provider: null, apiKey: '' };
}

// Read on every call (the file is tiny), so editing .env takes effect without restarting.
// parseEnv returns the values without touching process.env. Real environment variables
// still win, which is handy for a one-off run.
function loadAiConfig() {
  let fromFile = {};
  try {
    fromFile = parseEnv(fs.readFileSync(ENV_FILE, 'utf8'));
  } catch {
    // no .env: fine, the app just runs without AI
  }
  return configFromEnv((name) => (process.env[name] || fromFile[name] || '').trim());
}

// True when some provider has everything it needs; otherwise the AI step is off.
function aiIsConfigured(config) {
  return Boolean(config && config.provider && config.apiKey);
}

module.exports = { loadAiConfig, aiIsConfigured, configFromEnv, DEFAULT_GEMINI_MODELS };
