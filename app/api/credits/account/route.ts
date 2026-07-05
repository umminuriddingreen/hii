import { NextResponse } from 'next/server';
import { getCreditDashboard, parseCreditCurrency } from '@/lib/server/credits';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return NextResponse.json({ error: 'Sign in required.' }, { status: 401 });

  const url = new URL(request.url);
  const currency = parseCreditCurrency(url.searchParams.get('currency'));

  try {
    const dashboard = await getCreditDashboard(user.id, currency);
    return NextResponse.json(dashboard);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not load credit account.' },
      { status: 500 }
    );
  }
}
