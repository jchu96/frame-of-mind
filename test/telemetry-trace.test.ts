import { describe, expect, it } from "vitest";
import {
  ANALYSIS_SPAN_NAMES,
  ANALYSIS_SPAN_OPS,
  NOOP_ANALYSIS_TRACER,
  isSafeTraceAttribute,
  scrubSentryTransactionEvent,
  scrubTraceAttributes,
} from "../src/lib/telemetry-trace.js";

const TRACE_ID = "a".repeat(32);
const SPAN_ID = "b".repeat(16);

function transactionFixture() {
  return {
    type: "transaction" as const,
    event_id: "c".repeat(32),
    transaction: "analyze run",
    start_timestamp: 1_000,
    timestamp: 1_060,
    platform: "javascript",
    environment: "cli",
    sdk: { name: "sentry.javascript.bun", version: "10.70.0" },
    contexts: {
      trace: {
        trace_id: TRACE_ID,
        span_id: SPAN_ID,
        op: "gen_ai.invoke_agent",
        status: "ok",
        data: {
          "gen_ai.request.model": "gemini-3.7-flash",
          "frame_of_mind.recipe_id": "issue-review",
        },
      },
    },
    spans: [
      {
        span_id: "d".repeat(16),
        parent_span_id: SPAN_ID,
        trace_id: TRACE_ID,
        start_timestamp: 1_001,
        timestamp: 1_020,
        op: "gen_ai.chat",
        description: "gemini index",
        status: "ok",
        data: {
          "gen_ai.usage.input_tokens": 4_200,
          "gen_ai.usage.output_tokens": 900,
          "frame_of_mind.candidates_indexed": 16,
        },
      },
    ],
  };
}

describe("trace attribute safety", () => {
  it("admits per-key valid values", () => {
    expect(isSafeTraceAttribute("gen_ai.request.model", "gemini-3.7-flash")).toBe(true);
    expect(isSafeTraceAttribute("frame_of_mind.recipe_id", "issue-review")).toBe(true);
    expect(isSafeTraceAttribute("frame_of_mind.recipe_id", "custom")).toBe(true);
    expect(isSafeTraceAttribute("gen_ai.usage.input_tokens", 42)).toBe(true);
    expect(isSafeTraceAttribute("frame_of_mind.candidate_accepted", true)).toBe(true);
    expect(isSafeTraceAttribute(
      "frame_of_mind.candidate_failure_code",
      "schema_validation",
    )).toBe(true);
  });

  it("rejects identifier-SHAPED private values under allowed keys", () => {
    // The blocker case: operator-controlled strings that look like
    // identifiers must find no key that accepts them.
    expect(isSafeTraceAttribute("gen_ai.request.model", "customer-call.mp4")).toBe(false);
    expect(isSafeTraceAttribute("gen_ai.request.model", "a".repeat(40))).toBe(false);
    expect(isSafeTraceAttribute("gen_ai.request.model", "sk-live_0123456789abcdef")).toBe(false);
    expect(isSafeTraceAttribute("frame_of_mind.recipe_id", "alices-meeting-notes")).toBe(false);
    expect(isSafeTraceAttribute("frame_of_mind.recipe_id", "alice-meeting-2026-08-24")).toBe(false);
    expect(isSafeTraceAttribute("frame_of_mind.depth", "gemini-3.7-flash")).toBe(false);
    expect(isSafeTraceAttribute("frame_of_mind.outcome", "custom-status")).toBe(false);
    // Numeric keys reject strings; string keys reject numbers.
    expect(isSafeTraceAttribute("gen_ai.usage.input_tokens", "42")).toBe(false);
    expect(isSafeTraceAttribute("gen_ai.usage.input_tokens", -1)).toBe(false);
    expect(isSafeTraceAttribute("gen_ai.usage.input_tokens", 1.5)).toBe(false);
    expect(isSafeTraceAttribute("frame_of_mind.recipe_id", 7)).toBe(false);
  });

  it("rejects content-shaped, path-shaped, and secret-shaped values everywhere", () => {
    for (const key of ["gen_ai.request.model", "frame_of_mind.recipe_id", "sentry.op"]) {
      expect(isSafeTraceAttribute(key, "she said the fibroid was 9 cm")).toBe(false);
      expect(isSafeTraceAttribute(key, "C:\\Users\\someone\\video.mp4")).toBe(false);
      expect(isSafeTraceAttribute(key, "/home/user/recording.mp4")).toBe(false);
      expect(isSafeTraceAttribute(key, "a".repeat(64))).toBe(false);
      expect(isSafeTraceAttribute(key, Number.NaN)).toBe(false);
      expect(isSafeTraceAttribute(key, { nested: true })).toBe(false);
    }
  });

  it("drops non-allowlisted keys, unknown sentry keys, and per-key invalid values", () => {
    expect(scrubTraceAttributes({
      "gen_ai.request.model": "gemini-3.7-flash",
      "gen_ai.input.messages": "safe_looking_value",
      "gen_ai.output.messages": "safe_looking_value",
      "gen_ai.system_instructions": "safe_looking_value",
      "custom.free_text": "hello",
      "sentry.origin": "manual",
      "sentry.unexpected_future_key": "value",
      "frame_of_mind.recipe_id": "not-a-built-in-recipe",
    })).toEqual({
      "gen_ai.request.model": "gemini-3.7-flash",
      "sentry.origin": "manual",
    });
  });
});

describe("transaction scrubbing", () => {
  it("allowlist-constructs a vocabulary transaction", () => {
    const scrubbed = scrubSentryTransactionEvent(transactionFixture());
    expect(scrubbed).not.toBeNull();
    expect(scrubbed?.transaction).toBe("analyze run");
    expect(scrubbed?.transaction_info).toEqual({ source: "custom" });
    expect(scrubbed?.contexts.trace.op).toBe("gen_ai.invoke_agent");
    expect(scrubbed?.spans).toHaveLength(1);
    expect(scrubbed?.spans[0]?.data["gen_ai.usage.input_tokens"]).toBe(4_200);
    // Nothing outside the constructed shape survives.
    expect(Object.keys(scrubbed ?? {}).sort()).toEqual([
      "contexts", "environment", "event_id", "platform", "sdk", "spans",
      "start_timestamp", "timestamp", "transaction", "transaction_info", "type",
    ]);
  });

  it("drops the whole event for a non-vocabulary transaction name", () => {
    const event = transactionFixture();
    event.transaction = "GET /api/runs/secret-run-id" as never;
    expect(scrubSentryTransactionEvent(event)).toBeNull();
  });

  it("drops non-vocabulary child spans and content attributes individually", () => {
    const event = transactionFixture();
    event.spans.push({
      span_id: "e".repeat(16),
      parent_span_id: SPAN_ID,
      trace_id: TRACE_ID,
      start_timestamp: 1_021,
      timestamp: 1_030,
      op: "http.client",
      description: "POST https://generativelanguage.googleapis.com/upload?key=secret",
      status: "ok",
      data: {},
    });
    event.spans[0]!.data = {
      ...event.spans[0]!.data,
      "gen_ai.input.messages": "[{\"role\":\"user\"}]",
    } as never;
    const scrubbed = scrubSentryTransactionEvent(event);
    expect(scrubbed?.spans).toHaveLength(1);
    expect(JSON.stringify(scrubbed)).not.toContain("messages");
    expect(JSON.stringify(scrubbed)).not.toContain("googleapis");
  });

  it("rejects non-transaction events", () => {
    expect(scrubSentryTransactionEvent({ type: "event" })).toBeNull();
  });
});

describe("noop tracer", () => {
  it("is transparent and inert", async () => {
    const result = await NOOP_ANALYSIS_TRACER.span(
      { op: ANALYSIS_SPAN_OPS[0], name: ANALYSIS_SPAN_NAMES[0] },
      async (span) => {
        span.setAttributes({ "frame_of_mind.outcome": "complete" });
        return 7;
      },
    );
    expect(result).toBe(7);
  });
});
