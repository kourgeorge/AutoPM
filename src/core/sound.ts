import { spawn } from 'child_process';
import { isEphemeralStorage } from './storage';

const MAC_DING = '/System/Library/Sounds/Glass.aiff';

/**
 * A short ding when a position is entered or exited. Fire-and-forget: a missing player or
 * muted speaker must never affect trading, so every failure is swallowed.
 *
 * Silent in tests (`node --test` sets NODE_TEST_CONTEXT), in the replay harness (ephemeral
 * storage), and when SOUND=off.
 */
export function playDing(): void {
  if (process.env.SOUND === 'off' || process.env.NODE_TEST_CONTEXT || isEphemeralStorage()) return;
  try {
    if (process.platform === 'darwin') {
      const child = spawn('afplay', [MAC_DING], { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    } else {
      // Terminal bell: the only sound available everywhere without a dependency.
      process.stderr.write('\x07');
    }
  } catch { /* never let a sound break an order path */ }
}
