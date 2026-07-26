import { afterEach, describe, expect, it, vi } from "vitest";
import { GranolaApiClient } from "../src/adapters/granola-api.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Granola API adapter", () => {
  it("requires an explicit API key", async () => {
    await expect(new GranolaApiClient(undefined).connect()).rejects.toThrow(/GRANOLA_API_KEY/);
  });

  it("rejects non-API meeting identifiers before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new GranolaApiClient("test-key");
    await expect(client.meeting("uuid-like-id")).rejects.toThrow(/'not_' identifier/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes an authorized note without exposing the key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "not_1d3tmYTlCICgjy",
      title: "Product review",
      created_at: "2026-01-27T15:30:00Z",
      web_url: "https://notes.granola.ai/d/example",
      summary_text: "Reviewed the flow.",
      transcript: [{
        speaker: { source: "microphone", diarization_label: "Speaker A" },
        text: "Start here.",
        start_time: "2026-01-27T15:30:00Z",
      }],
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GranolaApiClient("test-key");
    const meeting = await client.meeting("not_1d3tmYTlCICgjy");
    expect(meeting.transport).toBe("api");
    expect(meeting.transcript).toContain("Speaker A: Start here.");
    const request = fetchMock.mock.calls[0];
    expect(String(request[0])).not.toContain("test-key");
  });

  it("accepts documented nullable note fields", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "not_1d3tmYTlCICgjy",
      title: null,
      summary_text: null,
      summary_markdown: null,
      transcript: null,
    }), { status: 200 })));
    const meeting = await new GranolaApiClient("test-key").meeting("not_1d3tmYTlCICgjy");
    expect(meeting.transcript).toBe("");
    expect(meeting.title).toBeUndefined();
  });
});
