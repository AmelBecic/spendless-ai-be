// A wall-clock bound for work the scheduler cannot afford to wait on forever.

/** Raised when the bounded operation outlives its budget. */
export class TimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded its ${timeoutMs}ms budget`);
    this.name = "TimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Resolve `operation`, or reject with `TimeoutError` after `timeoutMs`.
 *
 * The SDK already bounds each individual model call, but a per-user refresh is
 * several calls plus the database reads between them — so "every call is
 * bounded" does not add up to "the unit is bounded". This is the outer bound
 * that lets the job move on from a user who is taking too long.
 *
 * It does not *cancel* the underlying work — a promise cannot be cancelled from
 * outside — so the abandoned operation runs to completion in the background and
 * its result is discarded. That is acceptable here precisely because the caller
 * is a scheduler with nothing to hand back: the alternative is one wedged user
 * stalling every user behind them.
 *
 * The timer is always cleared, including on the success path, so a short
 * operation under a long budget does not hold the event loop open — which would
 * otherwise keep the process alive past shutdown.
 */
export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
  });

  try {
    return await Promise.race([operation, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
