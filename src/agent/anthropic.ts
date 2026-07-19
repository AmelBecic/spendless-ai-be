// The LLM seam. Every model call in the app goes through `LlmClient` so the
// profiling and suggestion agents depend on an interface rather than on
// `@anthropic-ai/sdk` — the same discipline as `AuthVerifier`, and for the same
// reasons: tests run offline against a stub, and the provider stays swappable.
//
// This module interprets; it never computes. The model returns structured data
// and nothing here does arithmetic on money — every figure a user sees is
// computed by `aggregate.ts` from the database, not read out of a completion.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { AppError } from "../http/errors";

/**
 * The model every agent runs on. Opus 4.8 rejects `temperature`, `top_p` and
 * `top_k` with a 400 — behaviour is steered by the prompt, so none of those
 * appear anywhere in this file.
 */
export const MODEL = "claude-opus-4-8";

/**
 * Thinking depth / token spend. `high` is the default and the floor for
 * intelligence-sensitive work; `low` suits short scoped calls.
 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Prompt caching only engages above a model-specific prefix size — 4096 tokens
 * on Opus 4.8. A shorter stable prefix silently will not cache: no error, just
 * `cache_creation_input_tokens: 0` forever. Roughly 4 characters per token, so
 * this is the character floor a system prompt must clear to be worth caching.
 */
export const MIN_CACHEABLE_PREFIX_CHARS = 4096 * 4;

/** Per-call token accounting, surfaced for cost logging and eval reporting. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to cache this call, billed at ~1.25x input. */
  cacheCreationInputTokens: number;
  /** Tokens served from cache this call, billed at ~0.1x input. */
  cacheReadInputTokens: number;
  /** Estimated USD for this call, from the rates below. */
  estimatedCostUsd: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

export interface LlmRequest<T> {
  /**
   * The stable, reusable instruction prefix — identical across calls of the
   * same kind. This is what gets cached, so it must not carry timestamps, user
   * ids, or anything else that varies per request.
   */
  system: string;
  /**
   * The per-request payload (stats, transactions, the previous summary). Always
   * placed after the cache breakpoint, so changing it costs a cache write of
   * this block alone rather than invalidating the system prefix.
   */
  input: string;
  /** Schema the response is validated against; also constrains generation. */
  schema: z.ZodType<T>;
  /** Call-site label for logs — correlates usage and failures. Not sent to the API. */
  schemaName: string;
  /**
   * Tool definitions. Part of the cached prefix (tools render before system), so
   * these must be stable per call site — a tool list built per request, or in a
   * non-deterministic order, invalidates the cache on every call.
   */
  tools?: Anthropic.ToolUnion[];
  effort?: Effort;
  maxTokens?: number;
}

export interface LlmClient {
  complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

/** Minimal logging surface, so this module doesn't couple to Fastify's logger. */
export interface LlmLogger {
  info(details: Record<string, unknown>, message: string): void;
  warn(details: Record<string, unknown>, message: string): void;
  error(details: Record<string, unknown>, message: string): void;
}

// Opus 4.8 list prices, USD per million tokens. Cache reads bill at ~0.1x input
// and cache writes at ~1.25x. Used for observability only — never for anything
// the user is shown.
const USD_PER_MTOK_INPUT = 5;
const USD_PER_MTOK_OUTPUT = 25;
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

const DEFAULT_MAX_TOKENS = 16000;
const DEFAULT_EFFORT: Effort = "high";

// The SDK defaults to a 10-minute timeout and 2 retries, which on a stalled
// provider would hang a request for half an hour. Bound both: retries are worth
// keeping (429s and 5xx are transient) but the wall-clock ceiling has to be
// something a caller can wait out — 2 min per attempt, 6 min worst case.
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 2;

function estimateCostUsd(usage: Omit<LlmUsage, "estimatedCostUsd">): number {
  const input =
    (usage.inputTokens +
      usage.cacheReadInputTokens * CACHE_READ_MULTIPLIER +
      usage.cacheCreationInputTokens * CACHE_WRITE_MULTIPLIER) *
    (USD_PER_MTOK_INPUT / 1_000_000);
  const output = usage.outputTokens * (USD_PER_MTOK_OUTPUT / 1_000_000);
  return input + output;
}

/**
 * Build the exact request params for a call. Pure and exported so the caching
 * contract can be asserted offline: the prefix ordering that makes caching work
 * is a property of this object, not of the network round trip.
 *
 * Render order is `tools` → `system` → `messages`, and a cache breakpoint covers
 * everything before it. One breakpoint on the last system block therefore caches
 * the tool definitions and the system prompt together — no second breakpoint
 * needed, and no way for the two to be cached inconsistently.
 */
export function buildMessageParams<T>(
  request: LlmRequest<T>,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    // Omitted entirely when absent — an explicit `tools: undefined` still
    // serialises differently across SDK versions than an absent key.
    ...(request.tools ? { tools: request.tools } : {}),
    // Adaptive thinking is off by default on Opus 4.8 — it must be set
    // explicitly or the model runs without thinking at all.
    thinking: { type: "adaptive" },
    output_config: {
      effort: request.effort ?? DEFAULT_EFFORT,
      format: zodOutputFormat(request.schema),
    },
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    // Everything volatile lives here, after the breakpoint.
    messages: [{ role: "user", content: request.input }],
  };
}

/**
 * Map an SDK failure onto the app's error shape, most-specific-first. `cause` is
 * always retained so the handler can log what actually happened — nothing here
 * swallows an error.
 *
 * Ordering note: in the TypeScript SDK `APIConnectionError` extends `APIError`,
 * so it must be matched before it or the branch is unreachable. (There is no
 * `APIStatusError` in this SDK — that is the Python client's name.)
 */
export function classifyLlmError(err: unknown): AppError {
  if (err instanceof Anthropic.RateLimitError) {
    return new AppError(429, "LLM_RATE_LIMITED", "the model is rate limited, retry shortly", {
      cause: err,
    });
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    // A bad or unauthorised key is our misconfiguration, never the caller's fault.
    return new AppError(500, "LLM_MISCONFIGURED", "the model provider rejected our credentials", {
      cause: err,
    });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AppError(500, "LLM_BAD_REQUEST", "the model rejected a malformed request", {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AppError(503, "LLM_UNAVAILABLE", "could not reach the model provider", {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIError) {
    return new AppError(502, "LLM_ERROR", "the model provider returned an error", { cause: err });
  }
  return new AppError(500, "LLM_ERROR", "the model call failed", { cause: err });
}

/**
 * The SDK client with both wall-clock bounds applied. Exported so the bounds are
 * assertable — an unbounded provider call is the failure mode this exists to
 * prevent, and a constant on its own proves nothing was wired up.
 */
export function createBoundedSdkClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: MAX_RETRIES });
}

export interface AnthropicLlmClientOptions {
  apiKey: string;
  logger: LlmLogger;
  /** Injected in tests to assert behaviour without a network call. */
  client?: Anthropic;
}

/**
 * The production client. Requires the key up front so a missing
 * `ANTHROPIC_API_KEY` fails at boot rather than on the first user request.
 */
export function createAnthropicLlmClient(opts: AnthropicLlmClientOptions): LlmClient {
  if (!opts.apiKey.trim()) {
    throw new Error("ANTHROPIC_API_KEY is required to construct the LLM client");
  }
  const anthropic = opts.client ?? createBoundedSdkClient(opts.apiKey);

  return {
    async complete<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      if (request.system.length < MIN_CACHEABLE_PREFIX_CHARS) {
        // Not fatal — the call still works, it just pays full price every time.
        opts.logger.warn(
          { schemaName: request.schemaName, systemChars: request.system.length },
          "system prompt is below the cacheable prefix floor; prompt caching will not engage",
        );
      }

      const params = buildMessageParams(request);
      let response;
      try {
        response = await anthropic.messages.parse(params);
      } catch (err) {
        const appError = classifyLlmError(err);
        opts.logger.error(
          { schemaName: request.schemaName, code: appError.code, cause: err },
          "model call failed",
        );
        throw appError;
      }

      const counts = {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheCreationInputTokens: response.usage.cache_creation_input_tokens ?? 0,
        cacheReadInputTokens: response.usage.cache_read_input_tokens ?? 0,
      };
      const usage: LlmUsage = { ...counts, estimatedCostUsd: estimateCostUsd(counts) };

      opts.logger.info(
        { schemaName: request.schemaName, model: MODEL, ...usage },
        "model call completed",
      );

      // `parse` yields no output when the response could not be validated
      // against the schema — a refusal or a truncated completion. Loose `== null`
      // deliberately covers `undefined` too: an absent field would otherwise slip
      // through and hand a downstream agent an undefined its type calls `T`,
      // which is the exact "misread as no findings" outcome this guards against.
      if (response.parsed_output == null) {
        throw new AppError(502, "LLM_UNPARSEABLE", "the model returned no schema-valid output", {
          cause: new Error(`stop_reason: ${response.stop_reason}`),
        });
      }
      return { data: response.parsed_output, usage };
    },
  };
}
