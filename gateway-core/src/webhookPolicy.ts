/** Retry schedule: ~44 hours in total across 9 attempts, with +/-10% jitter so retries don't stampede. */
export const RETRY_DELAYS_S = [10, 60, 300, 1800, 7200, 21600, 43200, 86400];
export const MAX_ATTEMPTS = RETRY_DELAYS_S.length + 1;
/** Disable an endpoint after this many deliveries in a row exhausted every retry. */
export const ENDPOINT_DISABLE_AFTER = 5;

/** Seconds until the next attempt after `attemptsMade` failures, or null when retries are exhausted. */
export function nextAttemptDelay(attemptsMade: number, rand: () => number = Math.random): number | null {
  if (attemptsMade >= MAX_ATTEMPTS) return null;
  return Math.round(RETRY_DELAYS_S[attemptsMade - 1] * (0.9 + 0.2 * rand()));
}
