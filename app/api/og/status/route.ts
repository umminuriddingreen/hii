import { NextResponse } from 'next/server';
import { getHiiOgStatus } from '@/lib/server/hii-agent-context';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(getHiiOgStatus());
}
