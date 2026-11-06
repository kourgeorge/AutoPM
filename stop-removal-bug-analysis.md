# Stop Removal Bug Analysis

## Issue Summary
The process was killed (likely OOM or manual intervention) while repeatedly logging that BRKB snapshot should be removed. The snapshot persisted through 15-21 consecutive reads despite `ORPHAN_STRIKES=2` threshold.

## Root Cause

**Location**: `src/strategy/stopOrders.ts`, lines 612-616

```typescript
const ids = [snapshots[key].stopOrderId, snapshots[key].takeProfitOrderId].filter((id): id is string => !!id);
const outcomes = await Promise.all(ids.map(id => broker.getOrder(id)));
if (!outcomes.some(o => o?.status === 'filled')) continue;  // ← BUG HERE
removePositionSnapshot(key);
absentFor.delete(key);
```

### The Bug
The snapshot removal is **blocked** by a check that requires at least one protective order to have `status === 'filled'`. However, positions can close for many reasons where orders are NOT filled:

1. **Manual close** - operator closes position directly
2. **Order expiration** - time-in-force expires
3. **Order cancellation** - cancelled by operator or system
4. **Order rejection** - venue rejects the order
5. **Process restart** - orders may be stale/unknown after restart

In BRKB's case, the protective orders likely expired, were cancelled, or failed - but NOT filled. This causes the `continue` statement to skip removal indefinitely.

### Why It Kept Logging
The counter (`absentFor`) correctly incremented from 15→21, but the removal logic never executed because the filled-order check always failed. The log message appears on every sweep (every 2 seconds per `executionLoop.ts`), creating the repetitive output.

## Impact

1. **Memory leak**: Orphaned snapshots accumulate over time
2. **Log spam**: Repeated warnings every 2 seconds
3. **Confusion**: Counter suggests removal should happen but never does
4. **Resource waste**: Unnecessary broker API calls to check dead orders

## Proposed Fix

### Primary Fix: Remove the Filled-Order Requirement

The filled-order check should be **informational only**, not a gate for removal:

```typescript
const ids = [snapshots[key].stopOrderId, snapshots[key].takeProfitOrderId]
  .filter((id): id is string => !!id);
const outcomes = await Promise.all(ids.map(id => broker.getOrder(id)));
const filled = outcomes.some(o => o?.status === 'filled');

logger.info(
  `[Stops] ${key} is not held at the venue on ${strikes} consecutive reads — removing its `
    + `snapshot${filled ? ' (protective order filled)' : ''}: ${JSON.stringify(snapshots[key])}`,
);

removePositionSnapshot(key);
absentFor.delete(key);
```

### Rationale
- The position being absent for `ORPHAN_STRIKES` consecutive reads is sufficient proof it's closed
- Whether the protective order filled is interesting context, but not a removal requirement
- The original intent was likely to avoid removing snapshots for positions that might reappear, but the consecutive-read threshold already handles that

## Enhanced Observability

### 1. Log Counter State
Add logging to show counter progression:

```typescript
const strikes = (absentFor.get(key) ?? 0) + 1;
absentFor.set(key, strikes);

if (strikes === 1) {
  logger.info(`[Stops] ${key} not held at venue (strike 1/${needed})`);
} else if (strikes < needed) {
  logger.info(`[Stops] ${key} still not held (strike ${strikes}/${needed})`);
  continue;
}
```

### 2. Alert on Stuck Snapshots
Add a warning when counter exceeds expected threshold significantly:

```typescript
if (strikes > needed * 3) {
  logger.warn(
    `[Stops] ${key} has been absent for ${strikes} reads (threshold: ${needed}) — `
      + `snapshot removal may be blocked. Snapshot: ${JSON.stringify(snapshots[key])}`
  );
}
```

### 3. Periodic Snapshot Audit
Add a scheduled check (e.g., hourly) that reports:
- Total snapshots vs held positions
- Snapshots with high absent counts
- Snapshots with missing/stale order IDs

## Prevention Measures

1. **Unit tests** for `unheldSnapshots` with various order states
2. **Integration test** that closes a position externally and verifies snapshot removal
3. **Monitoring alert** when snapshot count diverges from position count
4. **Documentation** clarifying that snapshots are ephemeral position metadata, not trade history

## Why the Process Was Killed

The "Killed" message indicates the OS terminated the process, likely due to:
- **OOM (Out of Memory)**: Most probable - accumulated orphaned snapshots, log buffer, or other memory leak
- **Manual kill**: Operator intervention due to log spam or hung state
- **System resource limits**: ulimit, cgroup, or container constraints

The repetitive logging (every 2s) suggests the process was running but stuck in this loop for an extended period before termination.
