// ai-config.js: reads the AI settings from the .env file in the project root.
// Main process only (rule 5): the key is returned to main.js and passed straight to ai.js.
// It is never sent to a page and never logged.

const fs = require('fs');
const path = require('path');
const { parseEnv } = require('util');

const ENV_FILE = path.join(__dirname, '..', '..', '.env');

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
  const get = (name) => (process.env[name] || fromFile[name] || '').trim();
  return {
    apiKey: get('AI_API_KEY'),
    accountId: get('AI_ACCOUNT_ID'),
    model: get('AI_MODEL') || undefined, // undefined = the default model in ai.js
  };
}

// The default provider needs both a key and an account id; without them the AI step is off.
function aiIsConfigured(config) {
  return Boolean(config.apiKey && config.accountId);
}

module.exports = { loadAiConfig, aiIsConfigured };
