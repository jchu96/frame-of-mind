export const HOSTED_ACCESS_WAIT_TIMEOUT_MS = 30_000;
export const BETTER_AUTH_HOSTED_ACCESS_STEP = "test:hosted-access-http:better-auth";

export function resolveHostedAccessStepTimeoutSeconds(
  step: string,
  defaultTimeoutSeconds: number,
  hostedAccessTimeoutSeconds: number,
): number {
  return step === BETTER_AUTH_HOSTED_ACCESS_STEP
    ? Math.min(defaultTimeoutSeconds, hostedAccessTimeoutSeconds)
    : defaultTimeoutSeconds;
}

export async function withHostedAccessTimeout<T>(
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = HOSTED_ACCESS_WAIT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`hosted_access_timeout: ${label}`));
      controller.abort();
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function hostedAccessFetch(
  label: string,
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = HOSTED_ACCESS_WAIT_TIMEOUT_MS,
): Promise<Response> {
  return withHostedAccessTimeout(
    label,
    (signal) => fetch(input, { ...init, signal }),
    timeoutMs,
  );
}
