// The record of which agent passes have already run, scoped to their owner.
//
// This table exists to answer one question — "has this pass already run for this
// user today?" — without consulting what the pass produced. A guard that keys on
// written rows silently never fires for a pass that legitimately writes none, so
// the user with the emptiest ledger paid for a completion on every retry. A row
// here is written either way.

import type { PrismaClient } from "@prisma/client";
import { isUniqueViolation } from "./shared";

/** Which agent a pass belongs to — mirrors the `AgentRunKind` enum. */
export type AgentRunKind = "profile" | "suggestions";

export interface AgentRunsRepository {
  /**
   * Write the row for today's pass, returning `true` when this caller wrote it
   * and `false` when it was already there.
   *
   * **The same primitive is used with two different meanings, deliberately, and
   * a reader needs to know which one a call site means:**
   *
   * - *Before* the work, it is a **mutex** — the unique key decides which of two
   *   concurrent passes pays for the completion, and the loser backs off. The
   *   scheduler's profile half uses it this way, because a cron firing twice (or
   *   a tick overlapping its predecessor) must not buy the same user twice.
   * - *After* the work, it is a **receipt** — a record that a pass happened,
   *   whatever it produced. `refreshSuggestions` uses it this way, because its
   *   race is already serialised on the user's row inside `createDailySet`, and
   *   what it actually needs to stop is the *retry hours later* re-buying a pass
   *   that legitimately wrote no rows.
   *
   * The distinction matters because a pre-claim forces the loser of a race to be
   * handed an empty result, which would contradict the "loser gets the winner's
   * rows" contract the suggestion path already guarantees.
   */
  claim(userId: string, kind: AgentRunKind, asOfDate: Date): Promise<boolean>;
  /**
   * Give up a claim, so the pass can be retried.
   *
   * The claim is taken before the work, which means a failed pass would
   * otherwise hold the day: one transient 503 and the user gets no refresh until
   * midnight. Releasing on failure trades that for the (bounded, logged)
   * possibility of retrying a pass that will fail again.
   */
  release(userId: string, kind: AgentRunKind, asOfDate: Date): Promise<void>;
  /** True when a pass of this kind has already been claimed for that day. */
  hasRun(userId: string, kind: AgentRunKind, asOfDate: Date): Promise<boolean>;
}

export function createAgentRunsRepository(
  prisma: Pick<PrismaClient, "agentRun">,
): AgentRunsRepository {
  return {
    async claim(userId, kind, asOfDate) {
      try {
        await prisma.agentRun.create({ data: { userId, kind, asOfDate } });
        return true;
      } catch (err) {
        // The row already exists, so someone else has today's pass. Any other
        // failure is a real error and must not be read as "already claimed" —
        // swallowing it here would turn an outage into a permanently skipped
        // refresh.
        if (isUniqueViolation(err)) return false;
        throw err;
      }
    },

    async release(userId, kind, asOfDate) {
      // deleteMany, not delete: releasing a claim that is already gone is not an
      // error, and `delete` would throw P2025 on the very path that is already
      // handling a failure.
      await prisma.agentRun.deleteMany({ where: { userId, kind, asOfDate } });
    },

    async hasRun(userId, kind, asOfDate) {
      const row = await prisma.agentRun.findUnique({
        where: { userId_kind_asOfDate: { userId, kind, asOfDate } },
        select: { id: true },
      });
      return row !== null;
    },
  };
}
