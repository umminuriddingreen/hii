// SPDX-License-Identifier: LicenseRef-BSL-1.1

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

export function rectFor(value) {
  if (!value || typeof value !== 'object') return null;
  const rect = {
    x: Math.round(finite(value.x)),
    y: Math.round(finite(value.y)),
    width: Math.round(finite(value.width)),
    height: Math.round(finite(value.height)),
    scale: finite(value.scale, 1),
  };
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

export function displayIndexForRect(rect, displays, fallback = 0) {
  const source = rectFor(rect);
  if (!source || !Array.isArray(displays) || displays.length === 0) return fallback;
  const center = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  const index = displays.findIndex((candidate) => {
    const display = rectFor(candidate);
    return display
      && center.x >= display.x
      && center.x < display.x + display.width
      && center.y >= display.y
      && center.y < display.y + display.height;
  });
  return index >= 0 ? index : fallback;
}

export function cropForRect(rect, display) {
  const source = rectFor(rect);
  const screen = rectFor(display);
  if (!source || !screen) return null;
  const left = Math.max(source.x, screen.x);
  const top = Math.max(source.y, screen.y);
  const right = Math.min(source.x + source.width, screen.x + screen.width);
  const bottom = Math.min(source.y + source.height, screen.y + screen.height);
  if (right <= left || bottom <= top) return null;
  return {
    x: left - screen.x,
    y: top - screen.y,
    width: right - left,
    height: bottom - top,
    scale: source.scale,
  };
}

export function captureFilter(rect, display, maxWidth) {
  const source = rectFor(rect);
  const screen = rectFor(display);
  const width = Math.min(Math.max(Math.round(finite(maxWidth, 1600)), 640), 3840);
  const filters = [];
  if (source && screen) {
    const crop = cropForRect(source, screen);
    const fullDisplay = crop
      && crop.x === 0
      && crop.y === 0
      && crop.width === screen.width
      && crop.height === screen.height;
    if (crop && !fullDisplay) filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  }
  filters.push(`scale='min(${width},iw)':-2`, 'format=yuvj420p');
  return filters.join(',');
}
