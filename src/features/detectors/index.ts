/**
 * The detector registry.
 *
 * Order is presentation only — `severity` decides who is woken, so nothing here depends on
 * the sequence. Risk-side detectors are listed first anyway, so a tick's event list reads
 * worst-first.
 *
 * `reviewDue` is absent deliberately: it fires off closed round trips, and the journal that
 * counts them does not exist yet (step 18).
 */

import type { Detector } from '../eventBus';
import { dailyLossDetector } from './account';
import { dataStaleDetector } from './dataHealth';
import {
  positionDropDetector,
  positionSurgeDetector,
  trailingDrawdownDetector,
} from './drawdown';
import { heartbeatDetector } from './heartbeat';
import { stopBreachDetector, takeProfitDetector } from './stopBreach';
import { emaCrossDownDetector, entrySignalDetector, rsiExitZoneDetector } from './technical';

export const DETECTORS: Detector[] = [
  stopBreachDetector,
  dailyLossDetector,
  trailingDrawdownDetector,
  positionDropDetector,
  emaCrossDownDetector,
  rsiExitZoneDetector,
  takeProfitDetector,
  positionSurgeDetector,
  entrySignalDetector,
  dataStaleDetector,
  heartbeatDetector,
];
