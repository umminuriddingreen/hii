// SPDX-License-Identifier: LicenseRef-BSL-1.1
import { describe, expect, it } from 'vitest';
import { captureFilter, cropForRect, displayIndexForRect } from '../../remote/host/remote-source.mjs';

const displays = [
  { x: 0, y: 0, width: 1728, height: 1117, scale: 2 },
  { x: 1728, y: 0, width: 1440, height: 900, scale: 1 },
];

describe('HII remote application source', () => {
  it('binds a window to the display containing its center', () => {
    expect(displayIndexForRect({ x: 1900, y: 80, width: 900, height: 700 }, displays, 0)).toBe(1);
  });

  it('clips window capture to the selected display and maps it to local coordinates', () => {
    expect(cropForRect({ x: 1600, y: 50, width: 500, height: 600 }, displays[0])).toEqual({
      x: 1600,
      y: 50,
      width: 128,
      height: 600,
      scale: 1,
    });
  });

  it('crops before scaling while a full display remains uncropped', () => {
    expect(captureFilter({ x: 220, y: 100, width: 1200, height: 800 }, displays[0], 1600))
      .toBe("crop=1200:800:220:100,scale='min(1600,iw)':-2,format=yuvj420p");
    expect(captureFilter(displays[0], displays[0], 1600))
      .toBe("scale='min(1600,iw)':-2,format=yuvj420p");
  });
});
