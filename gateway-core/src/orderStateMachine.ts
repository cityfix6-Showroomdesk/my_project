export type OrderStatus = "created" | "pending" | "paid" | "expired" | "failed";

const transitions: Record<OrderStatus, OrderStatus[]> = {
  created: ["pending", "paid", "expired", "failed"],
  pending: ["paid", "expired", "failed"],
  paid: [],
  expired: [],
  failed: [],
};

export const canTransition = (from: OrderStatus, to: OrderStatus) => transitions[from].includes(to);
