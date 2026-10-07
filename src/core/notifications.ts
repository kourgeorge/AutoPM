import crypto from 'crypto';
import { readValue, saveValue, appendRecord, transaction } from './storage';

interface Notification {
  id: string; at: string; type: string; message: string; actionId?: string;
  attempts: number; nextAttempt: number;
}
export function pendingNotifications(): Notification[] { return readValue('notificationOutbox') ?? []; }
export function notifyAccount(type: string, message: string, actionId?: string): void {
  const item: Notification = { id: crypto.randomUUID(), at: new Date().toISOString(), type, message, actionId, attempts: 0, nextAttempt: 0 };
  transaction(() => {
    appendRecord('notifications', item.id, item.at, item);
    // Delivery is opt-in. The durable activity record exists even without a destination.
    if (process.env.ALERT_WEBHOOK_URL) saveValue('notificationOutbox', [...pendingNotifications(), item]);
  });
}

/** At-least-once delivery. Receivers deduplicate using the stable Idempotency-Key header. */
export class NotificationDelivery {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  start(): void {
    const endpoint = process.env.ALERT_WEBHOOK_URL;
    if (!endpoint) return;
    if (new URL(endpoint).protocol !== 'https:') throw new Error('ALERT_WEBHOOK_URL must use HTTPS');
    this.timer = setInterval(() => {
      if (!this.active) this.active = this.deliver(endpoint).finally(() => { this.active = undefined; });
    }, 5_000);
  }
  private async deliver(endpoint: string): Promise<void> {
    const item = pendingNotifications().find(n => n.nextAttempt <= Date.now());
    if (!item) return;
    let delivered = false;
    try {
      const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(5_000),
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': item.id,
          ...(process.env.ALERT_WEBHOOK_TOKEN ? { Authorization: 'Bearer ' + process.env.ALERT_WEBHOOK_TOKEN } : {}) },
        body: JSON.stringify(item) });
      delivered = response.ok;
      await response.body?.cancel();
    } catch { /* Retry with the same identity. Do not log credentials or response bodies. */ }
    transaction(() => {
      saveValue('notificationOutbox', pendingNotifications().flatMap(n => n.id !== item.id ? [n] : delivered ? [] : [{ ...n, attempts: n.attempts + 1, nextAttempt: Date.now() + Math.min(3600_000, 10_000 * 2 ** Math.min(n.attempts, 9)) }]));
      if (delivered) appendRecord('notifications-sent', item.id, new Date().toISOString(), { id: item.id, delivered: true });
    });
  }
  async stop(): Promise<void> { clearInterval(this.timer); await this.active; }
}
