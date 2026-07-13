import { NextResponse } from 'next/server';
import { readHiiConfig } from '@/lib/server/hii-config';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Read-only surface config (capability hii.config.read). Writes happen only
// through AII: `hiid config set <dot.path> <value>`.
export async function GET() {
  return NextResponse.json({ config: readHiiConfig() });
}
