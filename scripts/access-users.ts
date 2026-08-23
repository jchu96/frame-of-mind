#!/usr/bin/env bun
/** Compatibility entry point for the Cloudflare Access membership mode. */
import { main } from "./studio-users";

try {
  await main(process.argv.slice(2), "cloudflare-access");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
