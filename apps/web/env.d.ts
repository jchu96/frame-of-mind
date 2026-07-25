import type { ExecutionContext } from "@cloudflare/workers-types";
import type { SessionInfo } from "./shared/types";

declare module "h3" {
  interface H3EventContext {
    frameOfMindUser?: SessionInfo;
    cloudflare?: {
      request: Request;
      env: {
        DB: D1Database;
      };
      context: ExecutionContext;
    };
  }
}

export {};
