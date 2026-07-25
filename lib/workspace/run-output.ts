const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const TOOL_MARKER_PATTERN = /\n(?:exec|browser|web|image_gen|tool|mcp[\w.-]*)\n/i;

function sanitizeRunLog(value: unknown) {
  return String(value ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_PATTERN, '');
}

/**
 * Extract the latest user-facing Codex response from a managed run log.
 * The full log remains the proof artifact; this bounded view is safe to render
 * as the spatial response while the run is still growing.
 */
export function visibleRunOutput(value: unknown, maxLength = 60_000) {
  const output = sanitizeRunLog(value).trim();
  if (!output) return '';

  const completed = [...output.matchAll(/(?:^|\n)tokens used\s*\n[\d,]+\s*\n/gi)].at(-1);
  if (completed?.index !== undefined) {
    const answer = output.slice(completed.index + completed[0].length).trim();
    if (answer) return answer.slice(-maxLength);
  }

  const codexMarkers = [...output.matchAll(/(?:^|\n)codex\s*\n/gi)];
  const latest = codexMarkers.at(-1);
  if (latest?.index !== undefined) {
    const start = latest.index + latest[0].length;
    const candidate = output.slice(start);
    const toolMarker = candidate.match(TOOL_MARKER_PATTERN);
    const answer = (toolMarker?.index === undefined ? candidate : candidate.slice(0, toolMarker.index)).trim();
    if (answer) return answer.slice(-maxLength);
  }

  if (/(?:^|\n)(?:OpenAI Codex v|user|exec|tokens used)\b/i.test(output)) return '';

  return output.slice(-maxLength);
}
