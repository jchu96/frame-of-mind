const MEDIA_KEY_PATTERN = /^(originalVideoUrl|original_video_url|recordingUrl|recording_url|videoUrl|video_url|finalUrl|downloadUrl|download_url)$/i;
const MEDIA_URL_PATTERN = /\.(webm|mp4|m4v|mov|mp3)(?:[?#]|$)|files\.app\.bluedothq\.com/i;

export function collectStrings(value: unknown): string[] {
  const strings: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string") {
      strings.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(visit);
    }
  };
  visit(value);
  return strings;
}

export function findMediaUrl(value: unknown): string | undefined {
  const candidates: Array<{ score: number; url: string }> = [];
  const visit = (node: unknown, key = ""): void => {
    if (typeof node === "string") {
      if (/^https:\/\//i.test(node) && MEDIA_KEY_PATTERN.test(key) && MEDIA_URL_PATTERN.test(node)) {
        const score =
          (/originalVideoUrl|original_video_url/i.test(key) ? 100 : 0) +
          (/finalUrl/i.test(key) ? 80 : 0) +
          (/files\.app\.bluedothq\.com/i.test(node) ? 50 : 0) +
          (/\.webm(?:[?#]|$)/i.test(node) ? 20 : 0);
        candidates.push({ score, url: node });
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, key));
      return;
    }
    if (node && typeof node === "object") {
      for (const [childKey, child] of Object.entries(node as Record<string, unknown>)) {
        visit(child, childKey);
      }
    }
  };
  visit(value);
  return candidates.sort((a, b) => b.score - a.score)[0]?.url;
}

export function firstStringForKeys(value: unknown, keys: RegExp): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.test(key) && typeof child === "string" && child.trim()) return child.trim();
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = firstStringForKeys(child, keys);
    if (found) return found;
  }
  return undefined;
}
