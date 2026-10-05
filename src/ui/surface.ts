/**
 * What the rest of the program may ask of "the UI", whichever one is running.
 *
 * Two implementations: `TerminalUI` (`ui.ts`, the blessed screen) and `HeadlessUI`
 * (`headless.ts`, no screen — for a server, where the operator reaches the bot through the
 * HTTP API in `server/api.ts` instead of a keyboard). Every caller imports the one `ui`
 * singleton from `ui.ts` and never learns which it got.
 *
 * Like the rest of `src/ui/`, this must stay importable without config: nothing here may pull
 * in `core/config.ts`, which throws at import time when `AI_API_KEY` is missing.
 */
import * as dotenv from 'dotenv';
import type { Cycle, Environment, EventRow, Lane, ProposalRow, TickSnapshot } from './dashboard';

// Needed here because `ui.ts` is the FIRST import in `daemon.ts`, before anything else has
// loaded `.env` — and `HEADLESS` may be set there. Idempotent.
dotenv.config();

/**
 * Explicit opt-in only. Not inferred from `process.stdout.isTTY`: a run piped through `tee`
 * would silently lose its screen, and a mode that changes with how the process was started is
 * one an operator can't predict.
 */
export const HEADLESS = /^(1|true|yes)$/i.test(process.env.HEADLESS?.trim() ?? '');

/**
 * One `/name args` operator command. Handled entirely outside the concierge: a slash command
 * is an instruction to the program, not to a model.
 *
 * Commands that need broker, journal or policy data are registered from `daemon.ts` (see
 * `core/operatorCommands.ts`) — this module must stay importable without config.
 */
export interface SlashCommand {
  name: string;
  aliases?: string[];
  /** Shown after the name in `/help`, e.g. `[days]`. */
  args?: string;
  help: string;
  run: (args: string) => void | Promise<void>;
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'TRADE' | 'TOOL';

/**
 * `approve <id>` / `reject <id> [reason...]`, case-insensitive. Matched against the raw input
 * line BEFORE anything reaches the concierge, so a decision never passes through a language
 * model. Shared by both UIs so the terminal and the API accept exactly the same words.
 */
export const DECIDE_COMMAND = /^(approve|reject)\s+(\S+)(?:\s+([\s\S]*))?$/i;

export interface OperatorUI {
  onMessage(handler: (line: string) => void): void;
  onQuit(handler: () => void): void;
  registerCommand(cmd: SlashCommand): void;
  log(level: LogLevel, msg: string): void;
  reply(msg: string): void;
  replyChart(lines: string[]): void;
  chartWidth(): number;
  alert(msg: string): void;
  setTick(tick: TickSnapshot): void;
  setEvents(events: EventRow[], eventLog: EventRow[]): void;
  setProposals(proposals: ProposalRow[]): void;
  setEnvironment(env: Environment): void;
  setVenueOpen(open: boolean | null): void;
  setTraderActivity(lane: Lane): void;
  setConciergeActivity(lane: Lane): void;
  setCycle(cycle: Cycle): void;
  setStatus(text: string): void;
  captureStreams(): void;
  close(): void;
}
