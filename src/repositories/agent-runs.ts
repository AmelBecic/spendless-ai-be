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
   * Claim today's pass for a user, returning `true` when the caller won it.
   *
   * A claim, not a log: the write happens *before* the model call, and the
   * unique key is what decides which of two concurrent passes actually pays for
   * a completion. The loser gets `false` and returns whatever is already stored,
   * so a race costs one completion rather than two.
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
