import { join } from "node:path";

export const E2E_PORT = Number(process.env.FRAME_OF_MIND_E2E_PORT || 32_417);
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
export const E2E_BOOTSTRAP_TOKEN =
  "frame-of-mind-e2e-bootstrap-capability-0123456789";
export const E2E_STORAGE_STATE = join(
  process.cwd(),
  "test-results",
  "playwright",
  "auth",
  "studio.json",
);
