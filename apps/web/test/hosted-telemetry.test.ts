import { describe, expect, test } from "bun:test";
import {
  createHostedTelemetry,
} from "../../workflows/src/telemetry";
import {
  hostedTelemetryEventSchema,
  type HostedTelemetryEvent,
} from "../../workflows/src/telemetry-contract";

describe("hosted codes-only telemetry", () => {
  test("does not create a transport boundary without a Workflows Worker DSN", async () => {
    let sends = 0;
    const telemetry = createHostedTelemetry({}, async () => {
      sends += 1;
      return new Response(null, { status: 200 });
    });
    expect(telemetry.enabled).toBe(false);
    await telemetry.emit(event("workflow", "failed", "hosted_workflow_failed"));
    expect(sends).toBe(0);
  });

  test("emits only scrubbed codes and structural fields for every terminal shape", async () => {
    const envelopes: string[] = [];
    const telemetry = createHostedTelemetry(
      {
        SENTRY_DSN: "https://publickey@sentry.example.test/123",
        SENTRY_ENVIRONMENT: "contract",
        SENTRY_RELEASE: "phase5a",
      },
      async (_input, init) => {
        envelopes.push(String(init?.body));
        return new Response(null, { status: 200 });
      },
    );
    expect(telemetry.enabled).toBe(true);
    const cases: HostedTelemetryEvent[] = [
      event("publication", "succeeded", "hosted_publication_succeeded"),
      event("workflow", "failed", "hosted_workflow_failed"),
      event("workflow", "timeout", "hosted_workflow_timeout"),
      event("cleanup", "canceled", "operator_canceled"),
      event("upload", "started", "hosted_upload_started"),
    ];
    for (const item of cases) await telemetry.emit(item);
    expect(envelopes).toHaveLength(cases.length);
    for (const [index, envelope] of envelopes.entries()) {
      const lines = envelope.split("\n");
      expect(lines).toHaveLength(3);
      const payload = JSON.parse(lines[2]!) as Record<string, unknown>;
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("person@example.test");
      expect(serialized).not.toContain("principal-subject");
      expect(serialized).not.toContain("recording.mp4");
      expect(serialized).not.toContain("files/provider-id");
      expect(serialized).not.toContain("https://media.example.test");
      expect(Object.keys(payload).sort()).toEqual([
        "environment",
        "event_id",
        "exception",
        "level",
        "platform",
        "release",
        "sdk",
        "tags",
        "timestamp",
      ]);
      expect(payload.tags).toMatchObject({
        area: cases[index]!.area,
        outcome: cases[index]!.outcome,
        code: cases[index]!.code,
        stage: "cleanup",
        jobId: "attempt_contract_0001",
        studioMode: "hosted",
      });
    }
  });

  test("rejects user, media, URI, filename, and message fields at the port", () => {
    for (const extra of [
      { principalSub: "principal-subject" },
      { email: "person@example.test" },
      { fileName: "recording.mp4" },
      { uri: "https://media.example.test/files/provider-id" },
      { message: "raw provider failure" },
    ]) {
      expect(hostedTelemetryEventSchema.safeParse({
        ...event("access", "failed", "access_assertion_invalid"),
        ...extra,
      }).success).toBe(false);
    }
  });

  test("keeps telemetry delivery best-effort", async () => {
    const telemetry = createHostedTelemetry(
      { SENTRY_DSN: "https://publickey@sentry.example.test/123" },
      async () => {
        throw new Error("synthetic transport failure");
      },
    );
    await expect(telemetry.emit(
      event("spend", "succeeded", "spend_reconciled_provider_usage"),
    )).resolves.toBeUndefined();
  });
});

function event(
  area: HostedTelemetryEvent["area"],
  outcome: HostedTelemetryEvent["outcome"],
  code: string,
): HostedTelemetryEvent {
  return {
    area,
    outcome,
    code,
    stage: "cleanup",
    jobId: "attempt_contract_0001",
    recipeId: "decisions",
    recipeRevision: "builtin-2026-07-27.1",
    model: "gemini-test",
    durationMs: 42,
    routeClass: "hosted_api",
    status: outcome === "failed" ? 503 : 200,
    byteCount: 0,
    studioMode: "hosted",
    version: "0.3.0",
  };
}
