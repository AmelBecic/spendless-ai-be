// The daily refresh job: walk the users, and for each one that has actually done
// something since we last looked, rebuild their profile and suggestions.
//
// This is the cost guardrail the deployed app needs most. Both agents are paid
// calls, and a user who has not touched the app since yesterday would otherwise
// buy a completion every single day for an answer identical to the one already
// stored. The skip below is what makes an idle user free.
//
// In-process by design: the sprint takes on no external scheduling infra, so the
// job is a bare interval owned by the server process. `runDailyRefresh` is
// exported separately from the interval that drives it, so the same pass can be
// triggered by a cron hitting the process later without changing anything here.

import type { ProfileSummary } from "../domain/types";
import type { AgentRunsRepository } from "../repositories/agent-runs";
import type { ProfilesRepository } from "../repositories/profiles";
import type { Period } from "./aggregate";
import { profilePeriod, refreshProfile } from "./profile-refresh";
import { refreshSuggestions, type SuggestRefreshDeps } from "./suggest-refresh";
import { TimeoutError, withTimeout } from "./timeout";

/** The scheduler logs at three levels; the suggestion path only needs `warn`. */
export interface SchedulerLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

export interface DailyRefreshDeps extends Omit<SuggestRefreshDeps, "logger"> {
  profiles: ProfilesRepository;
  agentRuns: AgentRunsRepository;
  logger: SchedulerLogger;
}

export interface DailyRefreshOptions {
  /**
   * Wall-clock budget for one user's whole refresh — both agents plus the reads
   * between them. Defaults to 5 minutes.
   */
  perUserTimeoutMs?: number;
  /** Users fetched per page while walking the roster. Defaults to 50. */
  pageSize?: number;
}

export interface DailyRefreshResult {
  scanned: number;
  refreshed: number;
  /** Users with no new activity — the ones that cost no completion. */
  skipped: number;
  failed: number;
}

const DEFAULT_PER_USER_TIMEOUT_MS = 300_000;
const DEFAULT_PAGE_SIZE = 50;

/** Epoch — "since forever", for a user who has never been summarised. */
const BEGINNING_OF_TIME = new Date(0);

/**
 * True when nothing has been recorded for this user since their last summary was
 * written, so re-running the agents would pay for the answer already stored.
 *
 * Measured from the previous summary's `createdAt` rather than its `asOfDate`:
 * the question is "has anything been entered since we last looked?", which is
 * what an insert timestamp answers and what day granularity cannot. This is the
 * same novelty test `profile-refresh` applies internally, so the scheduler and
 * the agent never disagree about what counts as new.
 *
 * A user who has never been summarised is measured from the epoch, which makes
 * the empty case fall out for free: someone who signed up and entered nothing has
 * no activity since the beginning of time and is idle, so an empty account never
 * buys a completion either.
 *
 * Both halves of the ledger count. A month of no spending but a cancelled
 * subscription is not an idle month — the commitment total the narrative quotes
 * has moved.
 */
async function isIdle(
  deps: DailyRefreshDeps,
  userId: string,
  previous: ProfileSummary | null,
): Promise<boolean> {
  const since = previous ? new Date(previous.createdAt) : BEGINNING_OF_TIME;
  const [transactions, expenses] = await Promise.all([
    deps.transactions.countCreatedSince(userId, since),
    deps.expenses.countChangedSince(userId, since),
  ]);
  return transactions === 0 && expenses === 0;
}

/**
 * One user's refresh, unbounded. Always called through `refreshUser`, which owns
 * the wall-clock budget — nothing here should be awaited without that bound.
 *
 * The idle check happens before anything paid: the only cost of an idle user is
 * the two run lookups, the summary read and two counts, all of which are indexed.
 *
 * The two halves are gated separately, which matters more than it looks. The
 * profile half writes a summary; `isIdle` then measures novelty from that
 * summary's `createdAt`. So a pass whose profile half succeeded and whose
 * suggestion half did not leaves the user looking *idle* on every subsequent
 * pass — freshly summarised, nothing recorded since — and their suggestions are
 * never generated at all. Resuming the unfinished half is what closes that.
 */
async function refreshUserUnbounded(
  deps: DailyRefreshDeps,
  userId: string,
  now: Date,
  period: Period,
  asOfDate: Date,
): Promise<boolean> {
  const [profileDone, suggestionsDone] = await Promise.all([
    deps.agentRuns.hasRun(userId, "profile", asOfDate),
    deps.agentRuns.hasRun(userId, "suggestions", asOfDate),
  ]);

  // Today's profile landed but its suggestion half did not: the user is idle by
  // construction, and skipping them here is exactly the trap described above.
  const resuming = profileDone && !suggestionsDone;

  if (!resuming) {
    const previous = await deps.summaries.latest(userId);
    if (await isIdle(deps, userId, previous)) return false;
  }

  if (!profileDone) {
    // Claimed before the work, not after — deliberately the opposite of the
    // suggestion receipt, and for a different job. Here the marker is the
    // scheduler's own mutex: a cron that fires twice, or a tick that overlaps
    // its predecessor, must not buy the same user's profile twice. The
    // suggestion receipt answers a different question (did a pass already run
    // hours ago?) and so is written after success. See `agent-runs.ts`.
    if (!(await deps.agentRuns.claim(userId, "profile", asOfDate))) {
      deps.logger.info({ userId, asOfDate: period.end }, "profile pass already claimed");
      return false;
    }

    try {
      await refreshProfile(deps, userId, now);
    } catch (err) {
      // Released so a transient failure does not cost the user their whole day —
      // without this, one 503 would leave the claim standing and every retry
      // until midnight would skip them. A *timeout* is handled by the caller,
      // which cannot let go of the claim at all; see `refreshUser`.
      await deps.agentRuns.release(userId, "profile", asOfDate);
      throw err;
    }
  }

  // Sequential, and deliberately after the profile: the suggestion agent reads
  // the summary the profile pass writes, so running them concurrently would
  // advise against a stale narrative.
  if (!suggestionsDone) {
    await refreshSuggestions({ ...deps, logger: deps.logger }, userId, now);
  }
  return true;
}

/**
 * Refresh one user under a single wall-clock budget, or skip them.
 *
 * One bound for the whole user, not one per half. Two inner bounds of `n` let a
 * user occupy the pass for `2n`, and left the reads *between* them unbounded
 * entirely — so a wedged database connection could stall the walk indefinitely,
 * which is the exact failure the budget exists to prevent. Wrapping the whole
 * unit is the only shape where the number in the option means what it says.
 *
 * On a timeout the user is marked done for the day, both halves. `withTimeout`
 * abandons an operation, it cannot cancel it: the refresh may still be in flight
 * and may still buy its completion. Retrying it on the next tick would pay for a
 * second one and race the writes. A timed-out user waits for tomorrow — the same
 * policy as the profile claim, applied to both halves rather than only the one
 * that happened to hold a claim.
 */
async function refreshUser(
  deps: DailyRefreshDeps,
  userId: string,
  now: Date,
  timeoutMs: number,
): Promise<boolean> {
  const period = profilePeriod(now);
  const asOfDate = new Date(`${period.end}T00:00:00.000Z`);

  try {
    return await withTimeout(
      refreshUserUnbounded(deps, userId, now, period, asOfDate),
      timeoutMs,
      `refresh ${userId}`,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      await Promise.all([
        deps.agentRuns.claim(userId, "profile", asOfDate),
        deps.agentRuns.claim(userId, "suggestions", asOfDate),
      ]);
    }
    throw err;
  }
}

/**
 * Run one full pass over every user.
 *
 * Users are processed one at a time rather than fanned out. Two reasons, both
 * load-bearing: a fan-out would multiply concurrent paid calls by the batch size
 * against a provider that rate-limits, and — the point of the caching AC — the
 * cached prompt prefix has a five-minute TTL, so walking users back to back
 * keeps every call after the first reading the prefix from cache instead of
 * rewriting it. The prefix is identical across users because it is a per-agent
 * constant carrying no user data; only the payload after the cache breakpoint
 * varies. See `buildMessageParams` in anthropic.ts.
 *
 * One user's failure never stops the pass: it is logged with its cause, counted,
 * and the walk continues. A job that aborts on the first bad user would leave
 * everyone after them stale, and on a paid path it would also throw away the
 * completions already bought.
 */
export async function runDailyRefresh(
  deps: DailyRefreshDeps,
  now: Date,
  options: DailyRefreshOptions = {},
): Promise<DailyRefreshResult> {
  const timeoutMs = options.perUserTimeoutMs ?? DEFAULT_PER_USER_TIMEOUT_MS;
  const limit = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const result: DailyRefreshResult = { scanned: 0, refreshed: 0, skipped: 0, failed: 0 };

  let cursor: string | undefined;
  do {
    const page = await deps.profiles.listUserIds({ limit, ...(cursor ? { cursor } : {}) });

    for (const userId of page.items) {
      result.scanned += 1;
      try {
        const refreshed = await refreshUser(deps, userId, now, timeoutMs);
        if (refreshed) result.refreshed += 1;
        else result.skipped += 1;
      } catch (err) {
        result.failed += 1;
        deps.logger.error({ userId, err }, "daily refresh failed for user");
      }
    }

    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  deps.logger.info({ ...result }, "daily refresh pass complete");
  return result;
}

export interface DailyRefreshJob {
  /** Stop the interval. Safe to call more than once. */
  stop(): void;
}

export interface StartDailyRefreshJobOptions extends DailyRefreshOptions {
  intervalMs: number;
  /** Injected in tests; defaults to the real clock. */
  now?: () => Date;
  /**
   * Run a pass immediately on start, rather than waiting a full interval.
   * Defaults to true — see the note below on why that default is load-bearing.
   */
  runOnStart?: boolean;
}

/**
 * Drive `runDailyRefresh` on an interval for as long as the process lives.
 *
 * **A pass runs immediately on start**, and this is not a convenience. The
 * interval is anchored to process start, so with the 24-hour default the first
 * tick would fire a day after boot — and any platform that redeploys, restarts
 * on crash, or sleeps idle instances more often than that resets the timer
 * before it ever fires. The job would then refresh nobody, ever, while logging
 * that it had started. The `AgentRun` claim is what makes the extra pass cheap:
 * a restart mid-day finds everyone already recorded and buys nothing.
 *
 * A pass never overlaps itself. If one run is still going when the next tick
 * fires, the tick is dropped rather than queued: two concurrent passes would
 * race on the same users, and on a paid path the loser's completions are money
 * spent on a result the winner overwrites. (The `AgentRun` claim makes that safe
 * rather than merely unlikely — this just avoids the wasted work.)
 *
 * The interval is `unref`'d so a pending tick cannot by itself hold the process
 * open during shutdown.
 */
export function startDailyRefreshJob(
  deps: DailyRefreshDeps,
  options: StartDailyRefreshJobOptions,
): DailyRefreshJob {
  const clock = options.now ?? ((): Date => new Date());
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) {
      deps.logger.warn({}, "daily refresh still running — skipping this tick");
      return;
    }
    running = true;
    try {
      await runDailyRefresh(deps, clock(), options);
    } catch (err) {
      // The per-user loop already swallows per-user failures, so reaching here
      // means the walk itself broke (the roster query, typically). Logged rather
      // than rethrown: an unhandled rejection in a timer would take the process
      // down, and a database blip must not kill a running API server.
      deps.logger.error({ err }, "daily refresh pass failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMs);
  timer.unref();

  let stopped = false;
  if (options.runOnStart ?? true) {
    // Not awaited: the caller is `server.ts`, which must go on to listen. The
    // pass logs its own outcome and swallows its own failures.
    void (async (): Promise<void> => {
      if (!stopped) await tick();
    })();
  }

  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
