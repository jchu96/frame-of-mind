import type { Page } from "@playwright/test";

export function collectClientErrors(
  page: Page,
  options: {
    ignoreConsoleError?: (message: string) => boolean;
  } = {},
): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    const text = message.text();
    if (
      message.type() === "error"
      && !options.ignoreConsoleError?.(text)
    ) {
      errors.push(`console: ${text}`);
    }
  });
  return errors;
}
