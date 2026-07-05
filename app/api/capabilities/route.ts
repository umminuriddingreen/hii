import { NextResponse } from 'next/server';
import { listCapabilities } from '@/lib/capabilities';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ capabilities: listCapabilities() });
}
