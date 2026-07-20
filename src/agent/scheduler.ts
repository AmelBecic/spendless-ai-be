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
import { profilePeriod, refreshProfile } from "./profile-refresh";
import { refreshSuggestions, type SuggestRefreshDeps } from "./suggest-refresh";
import { withTimeout } from "./timeout";

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
 * Refresh one user, or skip them. Returns whether a refresh actually ran.
 *
 * The idle check happens before anything paid: the only cost of an idle user is
 * the summary read and two counts, all of which are indexed.
 */
async function refreshUser(
  deps: DailyRefreshDeps,
  userId: string,
  now: Date,
  timeoutMs: number,
): Promise<boolean> {
  const previous = await deps.summaries.latest(userId);
  if (await isIdle(deps, userId, previous)) return false;

  const period = profilePeriod(now);
  const asOfDate = new Date(`${period.end}T00:00:00.000Z`);

  // Claimed before the work, so a cron that fires twice — or overlaps its own
  // previous run — pays once. The suggestion half claims its own kind inside
  // `refreshSuggestions`, so the on-demand route is covered by the same guard.
  const claimed = await deps.agentRuns.claim(userId, "profile", asOfDate);
  if (!claimed) {
    deps.logger.info({ userId, asOfDate: period.end }, "profile pass already ran today");
    return false;
  }

  try {
    await withTimeout(refreshProfile(deps, userId, now), timeoutMs, `profile refresh ${userId}`);
  } catch (err) {
    // Released so a transient failure does not cost the user their whole day —
    // without this, one 503 would leave the claim standing and every retry until
    // midnight would skip them.
    await deps.agentRuns.release(userId, "profile", asOfDate);
    throw err;
  }

  // Sequential, and deliberately after the profile: the suggestion agent reads
  // the summary the profile pass just wrote, so running them concurrently would
  // advise against a stale narrative.
  await withTimeout(
    refreshSuggestions({ ...deps, logger: deps.logger }, userId, now),
    timeoutMs,
    `suggestion refresh ${userId}`,
  );
  return true;
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
}

/**
 * Drive `runDailyRefresh` on an interval for as long as the process lives.
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

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
