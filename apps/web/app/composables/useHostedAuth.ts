import { createAuthClient } from "better-auth/vue";

export function useHostedAuth() {
  return createAuthClient();
}
