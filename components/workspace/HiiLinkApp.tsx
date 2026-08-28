'use client';

import { useEffect, useMemo, useState } from 'react';
import { getHiiContactCard, getHiiVpnStatus, openHiiLinkHandoff, type HiiContactCard, type HiiVpnStatus } from '@/lib/client/hii-bridge';

export function HiiLinkApp() {
  const [card, setCard] = useState<HiiContactCard | null>(null);
  const [vpn, setVpn] = useState<HiiVpnStatus | null>(null);
  const [recipient, setRecipient] = useState('');
  const [status, setStatus] = useState('Reading the local contact card…');
  const message = useMemo(() => card
    ? `Join me on HII. My signed contact is ${card.name} (${card.id}). I’ll send the private alpha link separately.`
    : 'Join me on HII. I’ll send the private alpha link separately.', [card]);

  useEffect(() => {
    Promise.all([getHiiContactCard(), getHiiVpnStatus()])
      .then(([contact, mesh]) => {
        setCard(contact);
        setVpn(mesh);
        setStatus(contact
          ? `HII account and ${mesh?.controlPlaneReady ? 'local mesh' : 'contact card'} found on this Mac. Nothing was uploaded.`
          : 'No local identity found. Run: hii login local --name <name>');
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : String(error)));
  }, []);

  const copyCard = async () => {
    if (!card) return;
    await navigator.clipboard.writeText(JSON.stringify(card, null, 2));
    setStatus('Contact card copied. It can now be pasted into a message.');
  };
  const handoff = async (kind: 'messages' | 'facetime') => {
    try {
      await openHiiLinkHandoff(kind, recipient, message);
      setStatus(kind === 'messages'
        ? 'Messages opened with a draft. Review it and press Send yourself.'
        : 'FaceTime opened for this contact. HII did not start a call.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <section className="hii-link-app">
      <header><div><strong>HII Link</strong><span>Private device mesh, local account, and explicit handoffs</span></div><em>LOCAL-FIRST · ACCOUNT-BOUND</em></header>
      <main>
        <article>
          <span>CONTACT CARD ON THIS MAC</span>
          <h2>{card?.name || 'Local identity required'}</h2>
          <p>{card?.id || 'Run hii login local, then reopen this application.'}</p>
          <dl><div><dt>Signature</dt><dd>{card ? `${card.signature.slice(0, 22)}…` : 'not available'}</dd></div><div><dt>Public key</dt><dd>{card ? `${card.publicKey.slice(0, 22)}…` : 'not available'}</dd></div></dl>
          <dl>
            <div><dt>Mesh</dt><dd>{vpn?.meshId ? `${vpn.meshId.slice(0, 22)}…` : 'not initialized'}</dd></div>
            <div><dt>Control plane</dt><dd>{vpn?.controlPlaneReady ? 'ready locally' : 'not ready'}</dd></div>
            <div><dt>Data plane</dt><dd>{vpn?.dataPlaneLive ? 'verified live' : 'not live'}</dd></div>
            <div><dt>Peers</dt><dd>{vpn?.peerCount ?? 0}</dd></div>
          </dl>
          <button type="button" disabled={!card} onClick={copyCard}>Copy contact card as JSON</button>
          <small>{vpn?.reasons?.[0] || 'Copying is the only action here that releases the card from HII.'} The private signing and VPN keys never leave this Mac.</small>
        </article>
        <aside>
          <span>OPEN AN APP — DO NOT SEND</span>
          <h3>Prepare a conversation in an Apple app.</h3>
          <label>Phone number or Apple Account email<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="Required; HII does not search Contacts" /></label>
          <p>{message}</p>
          <div><button type="button" disabled={!recipient.trim()} onClick={() => handoff('messages')}>Open draft in Messages</button><button type="button" disabled={!recipient.trim()} onClick={() => handoff('facetime')}>Open contact in FaceTime</button></div>
          <small>HII does not read Contacts or Messages history. It does not send the draft or start the FaceTime call. Those actions stay in Apple’s apps.</small>
        </aside>
      </main>
      <footer><span>{status}</span><b>local data → explicit copy or app open → your confirmation</b></footer>
    </section>
  );
}
