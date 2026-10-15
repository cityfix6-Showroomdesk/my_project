import type { PoolClient } from "pg";

/** Subscribable event types. "ping" is internal (endpoint test button). */
export const EVENT_TYPES = ["order.paid", "order.expired", "payment.flagged"] as const;
export type EventType = (typeof EVENT_TYPES)[number] | "ping";

/**
 * Writes to the outbox. ALWAYS call this inside the same transaction as the state change,
 * so an event exists if and only if the change committed.
 */
export async function emitEvent(
  c: Pick<PoolClient, "query">, o: { merchant_id: string; mode: string; id: string }, type: EventType, data: object
) {
  await c.query("INSERT INTO events (merchant_id, mode, type, order_id, data) VALUES ($1,$2,$3,$4,$5)",
    [o.merchant_id, o.mode, type, o.id, JSON.stringify(data)]);
}

/** The exact JSON body a merchant receives, and what GET /v1/events returns. */
export function buildPayload(ev: { id: string | number; type: string; mode: string; created_at: Date | string; data: unknown }) {
  return {
    id: `evt_${ev.id}`,
    object: "event",
    api_version: "2026-10-01",
    type: ev.type,
    created: Math.floor(new Date(ev.created_at).getTime() / 1000),
    mode: ev.mode,
    data: ev.data,
  };
}
