import { engineUrl } from './client/config';
import { TerminalClient } from './client/terminal';

// Set before loading the terminal singleton, overriding any old HEADLESS value in .env.
process.env.HEADLESS = '0';
process.env.AUTOTRADE_ROLE = 'tui';

async function main(): Promise<void> {
  const engine = engineUrl();
  const { ui } = await import('./ui/ui');
  const client = new TerminalClient(engine, ui as import('./ui/ui').TerminalUI);
  let closed = false;
  const close = () => { if (closed) return; closed = true; client.stop(); ui.close(); process.exit(0); };
  ui.onQuit(close);
  ui.onMessage(line => { void client.send(line).catch(error => {
    if (!closed) ui.log('WARN', `${error.message}. Request not retried; check the engine before resubmitting.`);
  }); });
  process.on('SIGINT', close); process.on('SIGTERM', close);
  ui.log('INFO', `Connecting to ${engine.origin}. Trading runs in the separate engine process.`);
  client.start();
}

void main().catch(error => { console.error(`TUI startup failed: ${error.message}`); process.exitCode = 1; });
