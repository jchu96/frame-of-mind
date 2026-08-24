import type { Locator, Page } from "@playwright/test";

export interface ContrastMeasurement {
  background: string;
  color: string;
  ratio: number;
  text: string;
}

export async function assertLocatorContrast(
  locator: Locator,
  label: string,
  minimum = 4.5,
): Promise<void> {
  const measurement = await locator.evaluate(measureElementContrast);
  if (measurement.ratio < minimum) {
    throw new Error(
      `${label}: expected contrast >= ${minimum}, received ${measurement.ratio} `
      + `(color ${measurement.color}, background ${measurement.background}).`,
    );
  }
}

export async function assertLocatorsContrast(
  locator: Locator,
  label: string,
  minimum = 4.5,
): Promise<void> {
  const count = await locator.count();
  if (count === 0) throw new Error(`${label}: expected at least one rendered node.`);
  for (let index = 0; index < count; index += 1) {
    await assertLocatorContrast(locator.nth(index), `${label} ${index + 1}`, minimum);
  }
}

export async function assertSelectionContrast(
  locator: Locator,
  label: string,
  minimum = 4.5,
): Promise<void> {
  const measurement = await locator.evaluate(measureSelectionContrast);
  if (measurement.ratio < minimum) {
    throw new Error(
      `${label}: expected selection contrast >= ${minimum}, received ${measurement.ratio} `
      + `(color ${measurement.color}, background ${measurement.background}).`,
    );
  }
}

export async function assertVisibleTextContrast(
  page: Page,
  label: string,
  minimum = 4.5,
): Promise<void> {
  const failures = await page.locator("body").evaluate((body, threshold) => {
    type Color = [number, number, number, number];
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Contrast oracle could not create a canvas context.");
    const parse = (value: string): Color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = value;
      context.fillRect(0, 0, 1, 1);
      const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
      return [red, green, blue, alpha / 255];
    };
    const composite = (foreground: Color, background: Color): Color => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3]);
      if (alpha === 0) return [0, 0, 0, 0];
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
        alpha,
      ];
    };
    const luminance = (color: Color): number => {
      const values = color.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!;
    };
    const measure = (element: Element): ContrastMeasurement => {
      const ancestors: Element[] = [];
      for (let current: Element | null = element; current; current = current.parentElement) {
        ancestors.push(current);
      }
      const background = ancestors.reverse().reduce(
        (currentBackground, current) => composite(
          parse(getComputedStyle(current).backgroundColor),
          currentBackground,
        ),
        [255, 255, 255, 1] as Color,
      );
      const style = getComputedStyle(element);
      const foreground = composite(parse(style.color), background);
      const foregroundLuminance = luminance(foreground);
      const backgroundLuminance = luminance(background);
      const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
      return {
        text: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) || "",
        ratio: Number(ratio.toFixed(2)),
        color: style.color,
        background: background.slice(0, 3).map(Math.round).join(","),
      };
    };
    return [...body.querySelectorAll("*")].flatMap((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      const hasText = [...element.childNodes].some((node) =>
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim())
      );
      if (!hasText || bounds.width <= 1 || bounds.height <= 1
        || style.display === "none" || style.visibility === "hidden"
        || Number(style.opacity) === 0 || element.closest("[disabled], [aria-disabled=true]")) return [];
      const measurement = measure(element);
      return measurement.ratio >= threshold ? [] : [measurement];
    }).slice(0, 20);
  }, minimum);
  if (failures.length > 0) {
    throw new Error(`${label}: visible text below ${minimum}:1 contrast: ${JSON.stringify(failures)}`);
  }
}

function measureElementContrast(element: Element): ContrastMeasurement {
  type Color = [number, number, number, number];
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Contrast oracle could not create a canvas context.");
  const parse = (value: string): Color => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
    return [red, green, blue, alpha / 255];
  };
  const composite = (foreground: Color, background: Color): Color => {
    const alpha = foreground[3] + background[3] * (1 - foreground[3]);
    if (alpha === 0) return [0, 0, 0, 0];
    return [
      (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
      (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
      (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
      alpha,
    ];
  };
  const luminance = (color: Color): number => {
    const values = color.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!;
  };
  const actualBackground = (): Color => {
    const ancestors: Element[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      ancestors.push(current);
    }
    return ancestors.reverse().reduce(
      (background, current) => composite(parse(getComputedStyle(current).backgroundColor), background),
      [255, 255, 255, 1] as Color,
    );
  };
  const background = actualBackground();
  const style = getComputedStyle(element);
  const foreground = composite(parse(style.color), background);
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  return {
    text: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) || "",
    ratio: Number(ratio.toFixed(2)),
    color: style.color,
    background: background.slice(0, 3).map(Math.round).join(","),
  };
}

function measureSelectionContrast(element: Element): ContrastMeasurement {
  type Color = [number, number, number, number];
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Contrast oracle could not create a canvas context.");
  const parse = (value: string): Color => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0, alpha = 0] = context.getImageData(0, 0, 1, 1).data;
    return [red, green, blue, alpha / 255];
  };
  const luminance = (color: Color): number => {
    const values = color.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * values[0]! + 0.7152 * values[1]! + 0.0722 * values[2]!;
  };
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const style = getComputedStyle(element, "::selection");
  const foreground = parse(style.color);
  const background = parse(style.backgroundColor);
  selection?.removeAllRanges();
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  const ratio = (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
  return {
    text: element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) || "",
    ratio: Number(ratio.toFixed(2)),
    color: style.color,
    background: style.backgroundColor,
  };
}
