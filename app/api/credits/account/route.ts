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
    const message = error instanceof Error ? error.message : 'Could not load credit account.';
    if (message.includes('credit_accounts') || message.includes('PGRST205')) {
      return NextResponse.json({
        account: {
          user_id: user.id,
          currency,
          balance_cents: 0,
          reserved_cents: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        accounts: [],
        ledger: [],
        jobs: [],
        warning: `Durable credit schema is not applied yet: ${message}`
      });
    }
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}
