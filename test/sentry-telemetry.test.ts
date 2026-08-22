import * as Sentry from "@sentry/bun";
import { afterAll, describe, expect, it } from "vitest";
import {
  isSafeTelemetryCode,
  scrubSentryEvent,
  telemetryCodeFromError,
  type ScrubbableSentryEvent,
} from "../src/lib/sentry-telemetry.js";

const FORBIDDEN_MARKERS = [
  "/Users",
  "token=",
  "logentry-secret",
  "culprit-secret",
  "@",
  "context_line",
  "abs_path",
] as const;

function worstCaseEvent(): ScrubbableSentryEvent {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_778_800_000,
    level: "error",
    platform: "javascript",
    environment: "local-studio",
    release: "0.2.0",
    sdk: {
      name: "sentry.javascript.bun",
      version: "10.70.0",
      integrations: ["logentry-secret"],
    },
    message: "analysis_failed",
    exception: {
      values: [{
        type: "Error",
        value: "analysis_failed",
        stacktrace: {
          frames: [{
            filename: "/Users/example/private.ts",
            abs_path: "/Users/example/private.ts",
            context_line: "const token=private",
          }],
        },
        mechanism: {
          handled: true,
          type: "generic",
          data: { source: "logentry-secret" },
        },
      }],
    },
    logentry: { formatted: "logentry-secret /Users/example/logentry.ts" },
    culprit: "culprit-secret /Users/example/culprit.ts",
    fingerprint: ["logentry-secret", "/Users/example/fingerprint.ts"],
    threads: {
      values: [{ stacktrace: { frames: [{ abs_path: "/Users/thread.ts" }] } }],
    },
    spans: [{
      description: "https://example.com/?token=private",
      data: { url: "/Users/example/span.ts" },
    }],
    sdkProcessingMetadata: { dynamicSamplingContext: { user: "person@example.com" } },
    logger: "culprit-secret",
    extra: { transcript: "private transcript line" },
    breadcrumbs: [{ message: "logentry-secret" }],
    request: { url: "https://example.com/?token=private" },
    user: { email: "person@example.com" },
    tags: {
      code: "analysis_failed",
      stage: "interrogating",
      jobId: "job_123",
      secret: "logentry-secret",
    },
    contexts: {
      recipeId: { value: "issue-review" },
      trace: { data: "culprit-secret" },
    },
    transaction: "/api/studio/jobs/private",
    modules: { private: "/Users/module" },
    server_name: "private-host",
    debug_meta: { images: [{ code_file: "/Users/debug" }] },
    unknown_future_field: { secret: "logentry-secret" },
  };
}

function expectForbiddenMarkersAbsent(serialized: string): void {
  for (const marker of FORBIDDEN_MARKERS) {
    expect(serialized, `unexpected marker ${marker}`).not.toContain(marker);
  }
}

describe("Sentry telemetry privacy scrubber", () => {
  it.each([
    "[00:00:01] Speaker 1: private transcript line",
    "/Users/example/private/recording.mp4",
    "https://example.com/watch?token=private",
    "GEMINI_API_KEY=AIzaSySyntheticSecret012345678901",
    "a".repeat(64),
    "meeting_id=private-meeting-123",
    "person@example.com",
  ])("drops unsafe exception text: %s", (value) => {
    expect(scrubSentryEvent({
      exception: { values: [{ type: "Error", value }] },
    })).toBeNull();
  });

  it("constructs a new event from the explicit allowlist", () => {
    const event = worstCaseEvent();
    const scrubbed = scrubSentryEvent(event);

    expect(scrubbed).not.toBe(event);
    expect(scrubbed).toEqual({
      event_id: "0123456789abcdef0123456789abcdef",
      timestamp: 1_778_800_000,
      level: "error",
      platform: "javascript",
      environment: "local-studio",
      release: "0.2.0",
      sdk: {
        name: "sentry.javascript.bun",
        version: "10.70.0",
      },
      exception: {
        values: [{
          type: "SanitizedTelemetryError",
          value: "analysis_failed",
        }],
      },
      tags: {
        code: "analysis_failed",
        stage: "interrogating",
        jobId: "job_123",
      },
      contexts: {
        recipeId: { value: "issue-review" },
      },
    });
    expectForbiddenMarkersAbsent(JSON.stringify(scrubbed));
    expect(JSON.stringify(event)).toContain("logentry-secret");
  });

  it("serializes the same allowlisted event through the real Bun SDK transport", async () => {
    const requestBodies: Array<string | Uint8Array> = [];
    Sentry.init({
      dsn: "https://public@example.com/1",
      _metadata: {
        sdk: {
          name: "sentry.javascript.bun",
          version: Sentry.SDK_VERSION,
          integrations: [],
          packages: [],
        },
      },
      defaultIntegrations: false,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      beforeSendTransaction: () => null,
      beforeBreadcrumb: () => null,
      beforeSend(event) {
        return scrubSentryEvent(event as unknown as ScrubbableSentryEvent) as typeof event | null;
      },
      transport: (options) => Sentry.createTransport(options, (request) => {
        requestBodies.push(request.body);
        return Promise.resolve({ statusCode: 200 });
      }),
    });

    Sentry.captureEvent(worstCaseEvent() as Sentry.Event);
    expect(await Sentry.flush(2_000)).toBe(true);

    const serialized = requestBodies
      .map((body) => typeof body === "string" ? body : new TextDecoder().decode(body))
      .join("\n");
    expect(serialized).toContain("analysis_failed");
    expect(serialized).toContain("SanitizedTelemetryError");
    expectForbiddenMarkersAbsent(serialized);
  });

  it("reduces provider statuses to code-only telemetry", () => {
    expect(telemetryCodeFromError({ status: 503 }, "analysis_failed"))
      .toBe("gemini_http_503");
    expect(telemetryCodeFromError(
      { telemetryCode: "gemini_http_429" },
      "analysis_failed",
    )).toBe("gemini_http_429");
    expect(telemetryCodeFromError(
      new Error("private provider response body"),
      "analysis_failed",
    )).toBe("analysis_failed");
    expect(isSafeTelemetryCode("a".repeat(64))).toBe(false);
    expect(isSafeTelemetryCode("analysis_failed")).toBe(true);
  });
});

afterAll(async () => {
  await Sentry.close(2_000);
});
