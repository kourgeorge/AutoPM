import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { engineUrl, webPort } from './client/config';

/** Own only the two children started here. Never stop an already-running engine. */
export function runPair(engineArgs: string[], interfaceArgs: string[], terminal: boolean, env = process.env): Promise<number> {
  return new Promise(resolve => {
    const children: ChildProcess[] = [];
    let remaining = 2, stopping = false, code = 0, engineError = '', deadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      // The engine has its own 25-second graceful drain deadline.
      deadline = setTimeout(() => {
        code = 1;
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 30_000);
      deadline.unref();
    };
    const done = () => {
      if (--remaining > 0) return;
      clearTimeout(deadline);
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
      // Wait until the terminal has restored the screen before printing startup errors.
      if (code !== 0 && engineError) process.stderr.write(engineError);
      resolve(code);
    };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    for (const [index, args] of [engineArgs, interfaceArgs].entries()) {
      const child = spawn(process.execPath, args, {
        env,
        stdio: index === 0 ? ['ignore', terminal ? 'ignore' : 'inherit', 'pipe'] : 'inherit',
      });
      children.push(child);
      if (index === 0) child.stderr?.on('data', chunk => {
        if (terminal) engineError = (engineError + chunk.toString()).slice(-16_384);
        else process.stderr.write(chunk);
      });
      child.on('error', error => {
        code = 1;
        engineError = (engineError + `Could not start ${index === 0 ? 'engine' : 'interface'}: ${error.message}\n`).slice(-16_384);
        stop();
      });
      child.on('exit', (exitCode, signal) => {
        if (exitCode && code === 0) code = exitCode;
        if (signal && !stopping) code = 1;
        stop();
      });
      child.on('close', done);
    }
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== 'tui' && mode !== 'web') throw new Error('Usage: launch <tui|web>');
  const port = Number(process.env.ENGINE_PORT ?? '8788');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ENGINE_PORT must be between 1 and 65535');
  const target = engineUrl();
  if (Number(target.port || 80) !== port) throw new Error('ENGINE_URL must point to ENGINE_PORT when starting a pair. Use start:tui or start:web to connect to another engine.');
  if (mode === 'web' && webPort() === port) throw new Error('WEB_PORT and ENGINE_PORT must differ');
  const extension = __filename.endsWith('.ts') ? '.ts' : '.js';
  const loader = extension === '.ts' ? ['-r', 'ts-node/register'] : [];
  console.log(`Starting engine + ${mode}. Closing this session stops both processes.`);
  process.exitCode = await runPair(
    [...loader, path.join(__dirname, 'daemon' + extension)],
    [...loader, path.join(__dirname, mode + extension)],
    mode === 'tui',
    { ...process.env, ENGINE_URL: target.origin, AUTOTRADE_PAIRED: '1' },
  );
}

if (require.main === module) void main().catch(error => { console.error(error.message); process.exitCode = 1; });
