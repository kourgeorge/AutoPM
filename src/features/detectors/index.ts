/**
 * The detector registry.
 *
 * Order is presentation only — `severity` decides who is woken, so nothing here depends on
 * the sequence. Risk-side detectors are listed first anyway, so a tick's event list reads
 * worst-first.
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
import { concentrationBreachDetector, portfolioDrawdownDetector } from './portfolio';
import { stopBreachDetector, takeProfitDetector } from './stopBreach';
import { emaCrossDownDetector, entrySignalDetector, rsiExitZoneDetector } from './technical';

export const DETECTORS: Detector[] = [
  stopBreachDetector,
  dailyLossDetector,
  portfolioDrawdownDetector,
  concentrationBreachDetector,
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
