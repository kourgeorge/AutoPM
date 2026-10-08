import fs from 'node:fs';
import type { OperatorUI } from './ui/surface';
import { DATA_DIR } from './core/paths';
import { acquireEngineLock } from './core/engineLock';

// The engine always runs without a terminal. Clients have their own entry points.
process.env.HEADLESS = '1';
process.env.AUTOTRADE_ROLE = 'engine';
process.env.API_PORT = process.env.ENGINE_PORT ?? '8788';

/** Keep startup diagnostics outside the terminal's captured output, including import errors. */
async function main(): Promise<void> {
  let ui: OperatorUI | undefined;
  try {
    const release = acquireEngineLock(DATA_DIR);
    process.once('exit', release);
    // Before runtime signal handlers exist, a canceled paired startup still releases its lock.
    const stopDuringImport = () => { ui?.close(); process.exit(0); };
    process.on('SIGINT', stopDuringImport); process.on('SIGTERM', stopDuringImport);
    ui = (await import('./ui/ui')).ui;
    const { run } = await import('./daemonRuntime');
    process.off('SIGINT', stopDuringImport); process.off('SIGTERM', stopDuringImport);
    await run();
  } catch (err) {
    // Restore the normal terminal before printing; an alternate-screen log vanishes on exit.
    try { ui?.close(); } catch { /* A broken view must not hide the startup cause. */ }
    const message = err instanceof Error ? err.message : String(err);
    fs.writeSync(2, `AutoTrade startup failed: ${message}\n`);
    process.exit(1);
  }
}

void main();
