const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const env = { ...process.env, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-verify-')), HEADLESS:'1', BROKER:'alpaca', AI_PROVIDER:'ollama', AI_API_KEY:'test', ALPACA_KEY_ID:'test', ALPACA_SECRET_KEY:'test', ALPACA_BASE_URL:'https://paper-api.alpaca.markets' };
for (const script of ['src/scripts/replay.ts', 'src/scripts/verifyPolicyPrompt.ts']) {
  const result = spawnSync(process.execPath, ['-r','./scripts/no-network.cjs','-r','ts-node/register',script], { env, stdio:'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
