# hii — exchange a file for value

Upload a file, set license terms and a price, get one shareable link.
The buyer pays through Stripe and receives a time-limited secure download.

**The loop (all implemented):**
auth → upload (server action → Cloudflare R2) → exchange link `/x/[id]` →
Stripe Checkout (`/api/checkout`) → webhook marks order paid
(`/api/stripe/webhook`) → download re-verifies payment live with Stripe and
mints a 5-minute presigned R2 URL (`/api/download`), logging each download.

## Stack

- Next.js 14 (App Router) + Tailwind
- Supabase — Postgres, Auth (SSR sessions via `middleware.ts`), RLS
  deny-by-default with per-seller policies (`supabase/schema.sql`)
- Cloudflare R2 for file storage (S3 SDK, presigned GETs)
- Stripe Checkout + signature-verified webhook

## Run

```sh
npm install
cp .env.example .env   # fill: Supabase ×3, R2 ×4, Stripe ×2, base URL
npm run dev
```

Stripe webhook locally: `stripe listen --forward-to localhost:3000/api/stripe/webhook`

## Ship checklist

- [ ] Hosting target (Vercel is the zero-config fit for this stack) + custom domain
- [ ] Stripe live keys + live webhook endpoint
- [ ] Direct-to-R2 presigned uploads (server-action upload caps file size at the host body limit)
- [ ] Receipt email with re-download link after purchase (Resend)
- [ ] Basic tests around checkout/webhook/download

## Related

AII Agent Workstation (`~/dev/aii-workstation`) is the operator-side control
plane of the same HII/AII system — it reads the HII runtime (`~/.hii`) and is
the tool used to build and run products like this one.
