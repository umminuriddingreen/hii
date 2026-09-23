import { describe, expect, it } from 'vitest';
import {
  HII_WEB_CAPTURE_KIND,
  HII_WEB_CAPTURE_SCHEMA_VERSION,
  normalizeWebCapture,
  WebCaptureValidationError
} from '../../lib/capture/web-capture-contract';

const baseCapture = () => ({
  schemaVersion: HII_WEB_CAPTURE_SCHEMA_VERSION,
  kind: HII_WEB_CAPTURE_KIND,
  source: { url: 'https://example.com/reference', title: ' Example ' },
  capture: { method: 'extension-action', tags: [' Research ', 'browser', 'research', ''] },
  authority: { client: 'chrome-extension', localOnly: true }
});

describe('web capture contract', () => {
  it('normalizes a local explicit capture and supplies identity and time', () => {
    const capture = normalizeWebCapture(baseCapture(), {
      now: () => new Date('2026-09-12T20:00:00Z'),
      createId: () => 'capture-1'
    });

    expect(capture).toMatchObject({
      schemaVersion: 1,
      kind: 'hii.web.capture',
      captureId: 'capture-1',
      capturedAt: '2026-09-12T20:00:00.000Z',
      source: { url: 'https://example.com/reference', title: 'Example' },
      capture: { method: 'extension-action', tags: ['browser', 'research'] },
      authority: { client: 'chrome-extension', localOnly: true }
    });
  });

  it('preserves selected text separately from a user-authored note', () => {
    const capture = normalizeWebCapture({
      ...baseCapture(),
      captureId: 'capture-selection',
      capturedAt: '2026-09-12T20:01:02-04:00',
      capture: {
        method: 'context-selection',
        selectedText: '  The selected source passage.  ',
        note: ' Compare this with the brief. ',
        tags: []
      }
    });

    expect(capture.capturedAt).toBe('2026-09-13T00:01:02.000Z');
    expect(capture.capture.selectedText).toBe('The selected source passage.');
    expect(capture.capture.note).toBe('Compare this with the brief.');
  });

  it('accepts explicit local browser-library imports with browser provenance', () => {
    const capture = normalizeWebCapture({
      ...baseCapture(),
      capture: {
        method: 'extension-page-index',
        browserName: 'Chrome',
        browserTabId: 42,
        tags: ['browser-library', 'open-tab']
      }
    });
    expect(capture.capture).toMatchObject({
      method: 'extension-page-index',
      browserName: 'Chrome',
      browserTabId: 42
    });
  });

  it('keeps structured activity metrics bounded and separate from ingest time', () => {
    const capture = normalizeWebCapture({
      ...baseCapture(),
      capturedAt: '2026-09-21T17:00:00Z',
      capture: {
        method: 'extension-page-index',
        tags: ['history'],
        occurredAt: '2026-09-20T12:00:00Z',
        sourceKind: 'history',
        domain: 'example.com',
        metrics: { visitCount: 3, typedCount: 1, contentChars: 900 },
        search: { provider: 'Google', query: 'spatial agents' }
      }
    });
    expect(capture.capturedAt).toBe('2026-09-21T17:00:00.000Z');
    expect(capture.capture).toMatchObject({
      occurredAt: '2026-09-20T12:00:00.000Z',
      sourceKind: 'history',
      domain: 'example.com',
      metrics: { visitCount: 3, typedCount: 1, contentChars: 900 },
      search: { provider: 'Google', query: 'spatial agents' }
    });
    expect(Object.hasOwn(capture.capture, 'location')).toBe(false);
  });

  it.each(['chrome://extensions', 'file:///tmp/private.html', 'javascript:alert(1)', 'not a url'])(
    'rejects unsupported source URL %s',
    (url) => {
      expect(() => normalizeWebCapture({ ...baseCapture(), source: { url } })).toThrow(WebCaptureValidationError);
    }
  );

  it('rejects missing URLs and ambient or unknown capture methods', () => {
    expect(() => normalizeWebCapture({ ...baseCapture(), source: {} })).toThrow(/source\.url is required/);
    expect(() => normalizeWebCapture({
      ...baseCapture(),
      capture: { method: 'browser-history', tags: [] }
    })).toThrow(/explicit browser capture action/);
  });

  it('rejects non-local or non-extension authority', () => {
    expect(() => normalizeWebCapture({
      ...baseCapture(),
      authority: { client: 'chrome-extension', localOnly: false }
    })).toThrow(/local-only/);
    expect(() => normalizeWebCapture({
      ...baseCapture(),
      authority: { client: 'cloud-service', localOnly: true }
    })).toThrow(/chrome-extension/);
  });

  it('rejects unversioned and incorrectly shaped payloads', () => {
    expect(() => normalizeWebCapture({ ...baseCapture(), schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => normalizeWebCapture({ ...baseCapture(), kind: 'hii.browser.history' })).toThrow(/kind/);
    expect(() => normalizeWebCapture({
      ...baseCapture(),
      capture: { method: 'context-page', tags: 'browser' }
    })).toThrow(/array of strings/);
  });
});
