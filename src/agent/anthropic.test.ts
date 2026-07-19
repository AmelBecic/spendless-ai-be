// The LLM seam, exercised entirely offline. No test here makes a network call:
// the caching contract is a property of the request object, and the error
// mapping is a property of the SDK's exception classes — both assertable
// without spending a token.

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AppError } from "../http/errors";
import {
  MIN_CACHEABLE_PREFIX_CHARS,
  MODEL,
  buildMessageParams,
  classifyLlmError,
  createAnthropicLlmClient,
  createBoundedSdkClient,
  type LlmLogger,
  type LlmRequest,
} from "./anthropic";

const schema = z.object({ headline: z.string() });

/** A system prompt long enough to clear the cacheable-prefix floor. */
const longSystem = "You summarise spending. ".repeat(900);

function request(overrides: Partial<LlmRequest<{ headline: string }>> = {}) {
  return {
    system: longSystem,
    input: '{"totalCents":12345}',
    schema,
    schemaName: "profile_summary",
    ...overrides,
  } satisfies LlmRequest<{ headline: string }>;
}

function silentLogger(): LlmLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("buildMessageParams", () => {
  it("targets Opus 4.8 with adaptive thinking set explicitly", () => {
    const params = buildMessageParams(request());

    expect(params.model).toBe(MODEL);
    // Adaptive thinking is off by default on this model — omitting it means no
    // thinking at all, so its presence is the assertion that matters.
    expect(params.thinking).toEqual({ type: "adaptive" });
  });

  it("sends no sampling parameters — all three are a 400 on Opus 4.8", () => {
    const params = buildMessageParams(request());

    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("top_p");
    expect(params).not.toHaveProperty("top_k");
  });

  it("requests structured output via output_config.format, not the deprecated top-level field", () => {
    const params = buildMessageParams(request());

    expect(params.output_config?.format).toMatchObject({ type: "json_schema" });
    expect(params).not.toHaveProperty("output_format");
  });

  it("defaults effort to high and honours an override", () => {
    expect(buildMessageParams(request()).output_config?.effort).toBe("high");
    expect(buildMessageParams(request({ effort: "low" })).output_config?.effort).toBe("low");
  });

  // The caching contract. Invalidation is a prefix-ordering property, so these
  // three assertions are what actually catch a silent invalidator: a future
  // change that interpolates per-request data into the system prompt, or drops
  // the breakpoint, fails here rather than quietly costing full price forever.
  describe("prompt caching", () => {
    it("puts the cache breakpoint on the last system block", () => {
      const params = buildMessageParams(request());
      const system = params.system;

      expect(Array.isArray(system)).toBe(true);
      const blocks = system as Anthropic.TextBlockParam[];
      expect(blocks.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    });

    it("keeps per-request data out of the cached prefix", () => {
      const params = buildMessageParams(request({ input: '{"totalCents":999}' }));
      const systemText = (params.system as Anthropic.TextBlockParam[])
        .map((block) => block.text)
        .join("");

      expect(systemText).not.toContain("999");
      expect(params.messages[0]?.content).toContain("999");
    });

    it("holds the cached prefix byte-identical while per-request data varies", () => {
      const first = buildMessageParams(request({ input: '{"totalCents":1}' }));
      const second = buildMessageParams(request({ input: '{"totalCents":2}' }));

      expect(first.system).toEqual(second.system);
      expect(first.messages).not.toEqual(second.messages);
    });

    // Tools render before system, so the one breakpoint covers them too. The
    // whole prefix — tools included — has to stay stable as input varies.
    it("holds tools and system both stable across calls that differ only in input", () => {
      const tools = [
        {
          name: "lookup_category",
          description: "Resolve a category by name",
          input_schema: { type: "object" as const, properties: { name: { type: "string" } } },
        },
      ];
      const first = buildMessageParams(request({ tools, input: '{"totalCents":1}' }));
      const second = buildMessageParams(request({ tools, input: '{"totalCents":2}' }));

      // Assert the tools actually reached the params before comparing the two —
      // otherwise a build that drops them entirely satisfies `toEqual` as
      // undefined === undefined and the test passes while caching nothing.
      expect(first.tools).toEqual(tools);
      expect(first.tools).toEqual(second.tools);
      expect(first.system).toEqual(second.system);
      expect(first.messages).not.toEqual(second.messages);
    });

    it("omits the tools key entirely when no tools are supplied", () => {
      expect(buildMessageParams(request())).not.toHaveProperty("tools");
    });
  });
});

describe("classifyLlmError", () => {
  // Ordering matters: APIConnectionError extends APIError in this SDK, so a
  // broad APIError branch placed first would make the 503 unreachable.
  const headers = new Headers();

  it("maps a rate limit to 429", () => {
    const err = new Anthropic.RateLimitError(429, undefined, "slow down", headers);
    expect(classifyLlmError(err)).toMatchObject({ statusCode: 429, code: "LLM_RATE_LIMITED" });
  });

  it("maps a connection failure to 503, not the generic API error", () => {
    const err = new Anthropic.APIConnectionError({ message: "socket hang up" });
    expect(classifyLlmError(err)).toMatchObject({ statusCode: 503, code: "LLM_UNAVAILABLE" });
  });

  it("maps a bad key to a 500 — our misconfiguration, not the caller's fault", () => {
    const err = new Anthropic.AuthenticationError(401, undefined, "bad key", headers);
    expect(classifyLlmError(err)).toMatchObject({ statusCode: 500, code: "LLM_MISCONFIGURED" });
  });

  it("retains the cause so nothing is swallowed", () => {
    const err = new Anthropic.RateLimitError(429, undefined, "slow down", headers);
    expect(classifyLlmError(err).cause).toBe(err);
  });

  it("maps an unrecognised throw to a 500 rather than letting it escape", () => {
    expect(classifyLlmError(new Error("boom"))).toMatchObject({ statusCode: 500 });
  });
});

describe("createAnthropicLlmClient", () => {
  function stubAnthropic(parse: () => unknown): Anthropic {
    return { messages: { parse } } as unknown as Anthropic;
  }

  const okResponse = {
    parsed_output: { headline: "Groceries dominate" },
    stop_reason: "end_turn",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4000,
    },
  };

  it("bounds the provider call — the SDK's own default is a 10-minute hang", () => {
    const sdk = createBoundedSdkClient("test-key");

    expect(sdk.timeout).toBeLessThanOrEqual(120_000);
    expect(sdk.maxRetries).toBeLessThanOrEqual(2);
  });

  it("refuses to construct without a key rather than failing at the first call", () => {
    expect(() => createAnthropicLlmClient({ apiKey: "  ", logger: silentLogger() })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("returns the parsed data and reports usage", async () => {
    const client = createAnthropicLlmClient({
      apiKey: "test-key",
      logger: silentLogger(),
      client: stubAnthropic(() => Promise.resolve(okResponse)),
    });

    const result = await client.complete(request());

    expect(result.data).toEqual({ headline: "Groceries dominate" });
    expect(result.usage.cacheReadInputTokens).toBe(4000);
    expect(result.usage.estimatedCostUsd).toBeGreaterThan(0);
  });

  it("logs token usage for every call", async () => {
    const logger = silentLogger();
    const client = createAnthropicLlmClient({
      apiKey: "test-key",
      logger,
      client: stubAnthropic(() => Promise.resolve(okResponse)),
    });

    await client.complete(request());

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100, outputTokens: 50 }),
      expect.stringContaining("completed"),
    );
  });

  it("warns when the system prompt is too short to ever cache", async () => {
    const logger = silentLogger();
    const client = createAnthropicLlmClient({
      apiKey: "test-key",
      logger,
      client: stubAnthropic(() => Promise.resolve(okResponse)),
    });

    await client.complete(request({ system: "short" }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ prefixChars: 5, systemChars: 5, toolChars: 0 }),
      expect.stringContaining("caching will not engage"),
    );
    expect(longSystem.length).toBeGreaterThanOrEqual(MIN_CACHEABLE_PREFIX_CHARS);
  });

  it("surfaces an unparseable response instead of passing null downstream", async () => {
    const client = createAnthropicLlmClient({
      apiKey: "test-key",
      logger: silentLogger(),
      client: stubAnthropic(() =>
        Promise.resolve({ ...okResponse, parsed_output: null, stop_reason: "refusal" }),
      ),
    });

    await expect(client.complete(request())).rejects.toMatchObject({
      code: "LLM_UNPARSEABLE",
    });
  });

  // An absent field must not slip past the null guard and reach a caller whose
  // type promises T — that is the same failure as the explicit null above.
  it("treats an absent parsed_output the same as an explicit null", async () => {
    const { parsed_output: _omitted, ...withoutOutput } = okResponse;
    const client = createAnthropicLlmClient({
      apiKey: "test-key",
      logger: silentLogger(),
      client: stubAnthropic(() => Promise.resolve({ ...withoutOutput, stop_reason: "max_tokens" })),
    });

    await expect(client.complete(request())).rejects.toMatchObject({
      code: "LLM_UNPARSEABLE",
    });
  });

  it("translates an SDK failure and logs it before rethrowing", async () => {
    const logger = silentLogger();
    const rateLimit = new Anthropic.RateLimitError(429, undefined, "slow down", new Headers());
    const client = createAnthropicLlmClient({
      apiKey: "test-key",
      logger,
      client: stubAnthropic(() => Promise.reject(rateLimit)),
    });

    await expect(client.complete(request())).rejects.toBeInstanceOf(AppError);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ cause: rateLimit }),
      expect.stringContaining("failed"),
    );
  });
});
