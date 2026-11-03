function cleanOptional(value) {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned || undefined;
}

function cleanIsoTimestamp(value) {
  const cleaned = cleanOptional(value);
  if (!cleaned) return undefined;
  const parsed = Date.parse(cleaned);
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function cleanDomain(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.hostname || undefined;
  } catch {
    return undefined;
  }
}

function cleanBoundedInteger(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function cleanMetrics(metrics) {
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) return undefined;
  const cleaned = {};
  const visitCount = cleanBoundedInteger(metrics.visitCount, 10_000_000);
  const typedCount = cleanBoundedInteger(metrics.typedCount, 10_000_000);
  const contentChars = cleanBoundedInteger(metrics.contentChars, 1_000_000);
  if (visitCount !== undefined) cleaned.visitCount = visitCount;
  if (typedCount !== undefined) cleaned.typedCount = typedCount;
  if (contentChars !== undefined) cleaned.contentChars = contentChars;
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function cleanSearch(search) {
  if (!search || typeof search !== "object" || Array.isArray(search)) return undefined;
  const provider = cleanOptional(search.provider)?.slice(0, 80);
  const query = cleanOptional(search.query)?.slice(0, 500);
  if (!provider || !query) return undefined;
  return { provider, query };
}

function normalizeTags(tags = []) {
  return [...new Set(tags.map((tag) => cleanOptional(tag)).filter(Boolean))];
}

export function buildWebCapture({
  url,
  title,
  method,
  selectedText,
  contentText,
  browserName,
  browserTabId,
  note,
  occurredAt,
  sourceKind,
  metrics,
  search,
  tags = [],
  capturedAt = new Date().toISOString(),
  captureId = crypto.randomUUID()
}) {
  const sourceUrl = cleanOptional(url);
  if (!sourceUrl) throw new Error("A source URL is required.");
  const normalizedMetrics = cleanMetrics({
    ...(metrics && typeof metrics === "object" ? metrics : {}),
    ...(typeof contentText === "string" && metrics?.contentChars === undefined
      ? { contentChars: contentText.length }
      : {})
  });

  const capture = {
    method,
    ...(cleanIsoTimestamp(occurredAt) ? { occurredAt: cleanIsoTimestamp(occurredAt) } : {}),
    ...(cleanOptional(sourceKind) ? { sourceKind: cleanOptional(sourceKind).slice(0, 80) } : {}),
    ...(cleanDomain(sourceUrl) ? { domain: cleanDomain(sourceUrl) } : {}),
    ...(normalizedMetrics ? { metrics: normalizedMetrics } : {}),
    ...(cleanSearch(search) ? { search: cleanSearch(search) } : {}),
    ...(cleanOptional(browserName) ? { browserName: cleanOptional(browserName) } : {}),
    ...(Number.isSafeInteger(browserTabId) && browserTabId >= 0 ? { browserTabId } : {}),
    tags: normalizeTags(tags)
  };
  const selection = cleanOptional(selectedText);
  const userNote = cleanOptional(note);
  if (selection) capture.selectedText = selection;
  if (userNote) capture.note = userNote;

  return {
    schemaVersion: 1,
    kind: "hii.web.capture",
    capturedAt,
    captureId,
    source: {
      url: sourceUrl,
      ...(cleanOptional(title) ? { title: cleanOptional(title) } : {})
    },
    capture,
    ...(typeof contentText === "string" ? { content: { text: contentText } } : {}),
    authority: {
      client: "chrome-extension",
      localOnly: true
    }
  };
}
