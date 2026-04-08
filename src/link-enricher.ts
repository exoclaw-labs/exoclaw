/**
 * Link Enricher — auto-summarize URLs found in inbound messages.
 *
 * Detects URLs in user messages, fetches their title/description,
 * and prepends a brief summary to the prompt. Saves the agent
 * from needing to call a web fetch tool for every shared link.
 *
 * Inspired by ZeroClaw's link_enricher.rs.
 */

const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/g;

// Skip URLs that are likely not useful to summarize
const SKIP_PATTERNS = [
  /\.(png|jpg|jpeg|gif|svg|ico|webp|mp4|mp3|wav|pdf)$/i,
  /^https?:\/\/localhost/,
  /^https?:\/\/127\./,
  /^https?:\/\/\[::1\]/,
];

export interface EnrichedLink {
  url: string;
  title: string | null;
  description: string | null;
}

/**
 * Extract and enrich URLs in a message.
 * Returns the original message with link summaries prepended.
 */
export async function enrichLinks(message: string, timeoutMs = 5000): Promise<string> {
  const urls = message.match(URL_REGEX);
  if (!urls || urls.length === 0) return message;

  // Deduplicate and filter
  const unique = [...new Set(urls)].filter(url =>
    !SKIP_PATTERNS.some(p => p.test(url))
  ).slice(0, 3); // Max 3 URLs per message

  if (unique.length === 0) return message;

  const enriched = await Promise.all(
    unique.map(url => fetchLinkMeta(url, timeoutMs).catch(() => null))
  );

  const summaries = enriched
    .filter((e): e is EnrichedLink => e !== null && (e.title !== null || e.description !== null))
    .map(e => {
      const parts = [`[${e.url}]`];
      if (e.title) parts.push(e.title);
      if (e.description) parts.push(`— ${e.description.slice(0, 150)}`);
      return parts.join(" ");
    });

  if (summaries.length === 0) return message;

  return `[Link context: ${summaries.join(" | ")}]\n\n${message}`;
}

async function fetchLinkMeta(url: string, timeoutMs: number): Promise<EnrichedLink | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "ExoClaw/1.0 (link-enricher)",
        "accept": "text/html",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;

    // Read just enough to get the <title> and meta description
    const text = await response.text();
    const head = text.slice(0, 10_000); // Only parse first 10KB

    const title = head.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() || null;
    const description =
      head.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1]?.trim() ||
      head.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1]?.trim() ||
      null;

    if (!title && !description) return null;

    return { url, title, description };
  } catch {
    return null;
  }
}
