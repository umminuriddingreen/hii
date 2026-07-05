import { NextResponse, type NextRequest } from 'next/server';
import { createHiiQuote, type HiiCurrency } from '@/lib/server/hii-credits';
import { getCapability } from '@/lib/capabilities';

const allowedCurrencies = new Set<HiiCurrency>(['usd', 'eur', 'gbp', 'credits']);

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const task = typeof body?.task === 'string' ? body.task : '';
  const currency = allowedCurrencies.has(body?.currency) ? (body.currency as HiiCurrency) : 'usd';
  const capabilityId =
    typeof body?.capabilityId === 'string' && getCapability(body.capabilityId)
      ? body.capabilityId
      : 'hii.agent.spawn';
  const maxBudgetCents =
    typeof body?.maxBudgetCents === 'number' && Number.isFinite(body.maxBudgetCents)
      ? Math.max(100, Math.round(body.maxBudgetCents))
      : undefined;

  return NextResponse.json({
    quote: createHiiQuote({
      task,
      currency,
      maxBudgetCents,
      capabilityId
    })
  });
}
