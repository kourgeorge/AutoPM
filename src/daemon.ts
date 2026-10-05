import fs from 'node:fs';
import type { OperatorUI } from './ui/surface';

/** Keep startup diagnostics outside the terminal's captured output, including import errors. */
async function main(): Promise<void> {
  let ui: OperatorUI | undefined;
  try {
    ui = (await import('./ui/ui')).ui;
    const { run } = await import('./daemonRuntime');
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
