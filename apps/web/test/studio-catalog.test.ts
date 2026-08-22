import { describe, expect, test } from "bun:test";
import type {
  MeetingCatalogPage,
} from "../../../src/domain/studio-ports";
import {
  StudioMeetingCatalogError,
  StudioMeetingCatalogService,
} from "../server-local/studio-catalog/service";
import { studioRecipeCatalog } from "../server-local/studio-catalog/recipes";

describe("Studio meeting catalog", () => {
  test("uses an explicit provider transport and always closes it", async () => {
    const order: string[] = [];
    const service = new StudioMeetingCatalogService((provider, transport) => {
      expect([provider, transport]).toEqual(["bluedot", "mcp"]);
      return {
        async connect() {
          order.push("connect");
        },
        async search(input): Promise<MeetingCatalogPage> {
          order.push(`search:${input.query}:${input.cursor}:${input.limit}`);
          return {
            items: [{
              id: "video-1",
              title: "Synthetic meeting",
              createdAt: "2026-07-27T12:00:00.000Z",
            }],
            nextCursor: "2",
          };
        },
        async close() {
          order.push("close");
        },
      };
    });

    await expect(service.search({
      provider: "bluedot",
      transport: "mcp",
      query: "reporting",
      cursor: "1",
      limit: 8,
    })).resolves.toEqual({
      items: [{
        id: "video-1",
        title: "Synthetic meeting",
        createdAt: "2026-07-27T12:00:00.000Z",
      }],
      nextCursor: "2",
    });
    expect(order).toEqual([
      "connect",
      "search:reporting:1:8",
      "close",
    ]);
  });

  test("fails closed when a provider has no catalog capability", async () => {
    const service = new StudioMeetingCatalogService(() => undefined);
    try {
      await service.search({
        provider: "granola",
        transport: "mcp",
        limit: 8,
      });
      throw new Error("Expected unavailable catalog.");
    } catch (error) {
      expect(error).toBeInstanceOf(StudioMeetingCatalogError);
      expect((error as StudioMeetingCatalogError).code)
        .toBe("catalog_unavailable");
      expect(String(error)).not.toContain("provider payload");
    }
  });

  test("closes a provider after sanitized catalog failure", async () => {
    let closed = false;
    const service = new StudioMeetingCatalogService(() => ({
      async connect() {},
      async search() {
        throw new Error("private provider payload");
      },
      async close() {
        closed = true;
      },
    }));
    await expect(service.search({
      provider: "bluedot",
      transport: "mcp",
      limit: 8,
    })).rejects.toMatchObject({ code: "catalog_failed" });
    expect(closed).toBe(true);
  });
});

describe("Studio recipe catalog", () => {
  test("projects built-ins without exposing analysis instructions", async () => {
    const catalog = await studioRecipeCatalog();
    expect(catalog.defaultModel).toBe("gemini-3.7-flash");
    expect(catalog.recipes.length).toBeGreaterThan(0);
    expect(catalog.recipes[0]).toEqual({
      id: expect.any(String),
      label: expect.any(String),
      description: expect.any(String),
      revision: expect.any(String),
    });
    expect(JSON.stringify(catalog)).not.toContain("indexInstruction");
    expect(JSON.stringify(catalog)).not.toContain("interrogationInstruction");
  });
});
