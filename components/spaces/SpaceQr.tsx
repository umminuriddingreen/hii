'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { generateOfflineSpaceQrDataUrl, spaceQrPayload } from '@/lib/spaces/access-link';

export type OfflineQrRenderer = (exactUrl: string) => ReactNode;

export type SpaceQrProps = {
  url: string;
  spaceName?: string;
  renderQr?: OfflineQrRenderer;
};

/**
 * Share UI around an exact access URL.
 *
 * QR encoding is injected so this component cannot silently call a hosted QR
 * service. The renderer must be backed by an in-process/offline encoder. Until
 * one is installed, the visible URL and open/copy controls remain a complete,
 * accessible fallback rather than displaying a fake QR.
 */
export function SpaceQr({ url, spaceName, renderQr }: SpaceQrProps) {
  const [copyStatus, setCopyStatus] = useState('');
  const [generatedQr, setGeneratedQr] = useState<
    { status: 'loading' } | { status: 'ready'; dataUrl: string } | { status: 'error' }
  >({ status: 'loading' });
  const payload = spaceQrPayload(url);

  useEffect(() => {
    if (renderQr) return;
    let current = true;
    setGeneratedQr({ status: 'loading' });
    void generateOfflineSpaceQrDataUrl(payload).then(
      (dataUrl) => {
        if (current) setGeneratedQr({ status: 'ready', dataUrl });
      },
      () => {
        if (current) setGeneratedQr({ status: 'error' });
      }
    );
    return () => {
      current = false;
    };
  }, [payload, renderQr]);

  async function copyUrl() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(url);
      setCopyStatus('Link copied.');
    } catch {
      setCopyStatus('Copy is unavailable. Select the link text instead.');
    }
  }

  return (
    <section className="hii-space-share" aria-labelledby="hii-space-share-title">
      <h2 id="hii-space-share-title">Share {spaceName || 'this Space'}</h2>
      {renderQr ? (
        <div
          className="hii-space-qr"
          data-qr-payload={payload}
          aria-label={`QR code for ${spaceName || 'this Space'}`}
        >
          {renderQr(payload)}
        </div>
      ) : generatedQr.status === 'ready' ? (
        <div
          className="hii-space-qr"
          data-qr-payload={payload}
          aria-label={`QR code for ${spaceName || 'this Space'}`}
        >
          <img
            src={generatedQr.dataUrl}
            width={320}
            height={320}
            alt={`Scan to open ${spaceName || 'this Space'}`}
          />
        </div>
      ) : (
        <p className="hii-space-qr-unavailable" role="status">
          {generatedQr.status === 'loading'
            ? 'Generating QR code…'
            : 'QR code unavailable. Open or copy the link below.'}
        </p>
      )}
      <p className="hii-space-share-url">
        <a href={url}>{url}</a>
      </p>
      <div className="hii-space-share-actions">
        <button type="button" onClick={() => void copyUrl()}>
          Copy link
        </button>
        <a href={url} target="_blank" rel="noreferrer">
          Open Space
        </a>
      </div>
      <p className="hii-space-copy-status" role="status" aria-live="polite">
        {copyStatus}
      </p>
    </section>
  );
}
