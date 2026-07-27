import { BluedotClient } from "../../../../src/adapters/bluedot-mcp.js";
import type {
  MeetingCatalogPage,
  MeetingCatalogSource,
} from "../../../../src/domain/studio-ports.js";
import {
  meetingCatalogPageSchema,
  meetingCatalogRequestSchema,
} from "../../../../src/domain/studio-schemas.js";

export type CatalogProvider = "bluedot" | "granola";
export type CatalogTransport = "mcp" | "api";

interface ConnectedMeetingCatalogSource extends MeetingCatalogSource {
  connect(): Promise<void>;
  close(): Promise<void>;
}

type CatalogFactory = (
  provider: CatalogProvider,
  transport: CatalogTransport,
) => ConnectedMeetingCatalogSource | undefined;

export class StudioMeetingCatalogError extends Error {
  constructor(readonly code: "catalog_unavailable" | "catalog_failed") {
    super("Meeting catalog request could not be completed.");
    this.name = "StudioMeetingCatalogError";
  }
}

function defaultFactory(
  provider: CatalogProvider,
  transport: CatalogTransport,
): ConnectedMeetingCatalogSource | undefined {
  if (provider === "bluedot" && transport === "mcp") {
    return new BluedotClient(
      process.env.BLUEDOT_MCP_URL,
      false,
      false,
    );
  }
  return undefined;
}

export class StudioMeetingCatalogService {
  constructor(private readonly factory: CatalogFactory = defaultFactory) {}

  async search(input: {
    provider: CatalogProvider;
    transport: CatalogTransport;
    query?: string;
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<MeetingCatalogPage> {
    const request = meetingCatalogRequestSchema.parse({
      provider: input.provider,
      transport: input.transport,
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      limit: input.limit,
    });
    const source = this.factory(request.provider, request.transport);
    if (!source) {
      throw new StudioMeetingCatalogError("catalog_unavailable");
    }
    try {
      await source.connect();
      return meetingCatalogPageSchema.parse(await source.search({
        ...(request.query ? { query: request.query } : {}),
        ...(request.cursor ? { cursor: request.cursor } : {}),
        limit: request.limit,
        ...(input.signal ? { signal: input.signal } : {}),
      }));
    } catch (error) {
      if (error instanceof StudioMeetingCatalogError) throw error;
      throw new StudioMeetingCatalogError("catalog_failed");
    } finally {
      await source.close().catch(() => undefined);
    }
  }
}

let configuredService: StudioMeetingCatalogService | undefined;

export function getStudioMeetingCatalogService():
  StudioMeetingCatalogService {
  configuredService ??= new StudioMeetingCatalogService();
  return configuredService;
}
