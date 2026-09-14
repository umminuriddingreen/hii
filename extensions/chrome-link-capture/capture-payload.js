function cleanOptional(value) {
  const cleaned = typeof value === "string" ? value.trim() : "";
  return cleaned || undefined;
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
  note,
  tags = [],
  capturedAt = new Date().toISOString(),
  captureId = crypto.randomUUID()
}) {
  const sourceUrl = cleanOptional(url);
  if (!sourceUrl) throw new Error("A source URL is required.");

  const capture = {
    method,
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
