import { afterAll, describe, expect, it } from "vitest";
import * as Sentry from "@sentry/bun";
import { createSentryAnalysisTracer } from "../src/lib/sentry-tracer.js";
import {
  scrubSentryTransactionEvent,
  type ScrubbableTransactionEvent,
} from "../src/lib/telemetry-trace.js";

const requestBodies: Array<string | Uint8Array> = [];

function serializedRequests(): string {
  return requestBodies
    .map((body) => typeof body === "string" ? body : new TextDecoder().decode(body))
    .join("\n");
}

describe("tracing through the real Bun SDK transport", () => {
  it("delivers an allowlisted transaction and strips content attributes end to end", async () => {
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
      environment: "cli",
      defaultIntegrations: false,
      sendDefaultPii: false,
      tracesSampleRate: 1,
      beforeSend: () => null,
      beforeBreadcrumb: () => null,
      beforeSendTransaction: (event) =>
        scrubSentryTransactionEvent(
          event as unknown as ScrubbableTransactionEvent,
        ) as unknown as typeof event | null,
      transport: (options) => Sentry.createTransport(options, (request) => {
        requestBodies.push(request.body);
        return Promise.resolve({ statusCode: 200 });
      }),
    });

    const tracer = createSentryAnalysisTracer();
    await tracer.span({
      op: "gen_ai.invoke_agent",
      name: "analyze run",
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": "google_genai",
        "gen_ai.request.model": "gemini-3.7-flash",
        "frame_of_mind.recipe_id": "issue-review",
      },
    }, async (root) => {
      await tracer.span({
        op: "gen_ai.chat",
        name: "gemini index",
        attributes: {
          "gen_ai.request.model": "gemini-3.7-flash",
          "gen_ai.usage.input_tokens": 4200,
          // Poisoned attributes a regression might set: content, an
          // operator-authored string, and a path. All must vanish.
          ...({
            "gen_ai.input.messages": "[{\"role\":\"user\",\"content\":\"private transcript\"}]",
            "frame_of_mind.recipe_id": "alices-meeting-notes",
            "custom.path": "C:\\Users\\someone\\customer-call.mp4",
          } as never),
        },
      }, async () => {});
      root.setAttributes({ "frame_of_mind.outcome": "complete" });
    });
    expect(await Sentry.flush(2_000)).toBe(true);

    const serialized = serializedRequests();
    expect(serialized).toContain("\"transaction\":\"analyze run\"");
    expect(serialized).toContain("gemini index");
    expect(serialized).toContain("4200");
    expect(serialized).toContain("\"frame_of_mind.outcome\":\"complete\"");
    expect(serialized).not.toContain("private transcript");
    expect(serialized).not.toContain("messages");
    expect(serialized).not.toContain("alices-meeting-notes");
    expect(serialized).not.toContain("customer-call");
    expect(serialized).not.toContain("custom.path");
  });

  it("drops a non-vocabulary root transaction wholesale", async () => {
    const before = serializedRequests().length;
    await Sentry.startSpan(
      { op: "gen_ai.invoke_agent", name: "GET /runs/private-run-id" },
      async () => {},
    );
    expect(await Sentry.flush(2_000)).toBe(true);
    const after = serializedRequests().slice(before);
    expect(after).not.toContain("private-run-id");
  });
});

afterAll(async () => {
  await Sentry.close(2_000);
});
