import type { PublicSpaceProjection } from './types.ts';

const styles = `
:root{color-scheme:light;--ink:#17211d;--paper:#f2efe5;--line:#b6b09f;--signal:#d94f2b;--leaf:#315f4b}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#fff 0,transparent 34%),var(--paper);color:var(--ink);font-family:Georgia,'Times New Roman',serif}
main{min-height:100vh;padding:clamp(28px,7vw,92px);display:grid;align-content:center;gap:28px}header{max-width:840px}small{font:700 12px/1.2 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--leaf)}
h1{font-size:clamp(48px,10vw,124px);line-height:.86;letter-spacing:-.055em;margin:.18em 0}p{font-size:clamp(18px,2.2vw,28px);line-height:1.35;max-width:720px}.actions{display:flex;gap:12px;flex-wrap:wrap}a{color:inherit;text-decoration:none;border:1px solid var(--ink);padding:12px 18px;border-radius:999px}a.primary{background:var(--ink);color:var(--paper)}
.canvas{position:relative;min-height:58vh;border:1px solid var(--line);overflow:hidden;background-image:linear-gradient(var(--line) 1px,transparent 1px),linear-gradient(90deg,var(--line) 1px,transparent 1px);background-size:32px 32px}.object{position:absolute;padding:18px;background:#fff8;border:1px solid var(--ink);box-shadow:8px 8px 0 #17211d18;overflow:hidden}.sticker{display:grid;place-items:center;border-radius:50%;background:var(--signal);color:white;font:bold 28px/1 ui-monospace,monospace}.status{font:600 13px/1.4 ui-monospace,monospace;color:var(--leaf)}
@media(max-width:640px){main{padding:24px}.canvas{min-height:66vh;display:flex;flex-direction:column;gap:16px;padding:16px;overflow-x:hidden}.object{position:relative;left:auto!important;top:auto!important;rotate:0deg!important;max-width:100%;transform:none}.object:not(.sticker){width:100%!important;height:auto!important;min-height:140px}.sticker{width:min(160px,50vw)!important;height:min(160px,50vw)!important;align-self:flex-end}}
`;

const INLINE_FAVICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%2317211d'/%3E%3Cpath d='M18 16v32M46 16v32M18 32h28' stroke='%23f2efe5' stroke-width='7'/%3E%3C/svg%3E";

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
}

function document(title: string, body: string, bootstrap?: PublicSpaceProjection) {
  const data = bootstrap
    ? `<script id="hii-space" type="application/json">${JSON.stringify(bootstrap).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)}</script>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="${INLINE_FAVICON}"><title>${escapeHtml(title)}</title><style>${styles}</style></head><body>${body}${data}</body></html>`;
}

export function spacesIndexPage(previewLink?: Readonly<{ href: string; label: string }>) {
  const optionalLink = previewLink
    ? `<a href="${escapeHtml(previewLink.href)}">${escapeHtml(previewLink.label)}</a>`
    : '';
  return document('HII Spaces', `<main><header><small>Human Information Interface / Spaces</small><h1>Every place can have a space.</h1><p>Create a shared digital surface, attach it to a QR code, and let it live on your hardware or publish it through HII.</p></header><div class="actions"><a class="primary" href="/new">Create a Space</a>${optionalLink}</div></main>`);
}

export function newSpacePage() {
  return document('Create an HII Space', `<main><header><small>Create / Local authority</small><h1>Start on your hardware.</h1><p>Space creation remains an explicit action in the local HII application. This public route never creates accounts, writes objects, accepts uploads, or grants host authority.</p></header><div class="actions"><a class="primary" href="/spaces">Understand Spaces</a></div></main>`);
}

export function spacePage(space: PublicSpaceProjection) {
  const objects = space.objects.map((object) => {
    const text = typeof object.content.text === 'string' ? object.content.text : object.type;
    return `<article class="object ${object.type === 'sticker' ? 'sticker' : ''}" style="left:${object.x}px;top:${object.y}px;width:${object.width}px;height:${object.height}px;rotate:${object.rotation}deg"><span>${escapeHtml(text)}</span></article>`;
  }).join('');
  const writeLabel = space.policy.write === 'local' ? 'Public read / local write' : 'Public read-only';
  return document(space.name, `<main><header><small>HII Space / ${escapeHtml(space.id)}</small><h1>${escapeHtml(space.name)}</h1><p class="status">${writeLabel}. The local HII node remains authoritative.</p></header><section class="canvas" aria-label="Public Space canvas">${objects}</section></main>`, space);
}
