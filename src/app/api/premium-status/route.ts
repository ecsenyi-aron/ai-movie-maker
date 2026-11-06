import { NextResponse } from 'next/server';
import { getPremiumConfigStatus } from '@/lib/agents/agent4-premium-config';

/**
 * GET /api/premium-status
 *
 * Szerveroldali állapot a Prémium Agent 4 UI-hoz:
 * - `provider`: 'mock' | 'real' (a kulcs szerveroldalon van, a böngésző nem látja)
 * - `mockActive`: a UI ezzel jelzi a "MOCK Provider aktív" feliratot
 *
 * Nem tartalmaz titkot: csak azt mondja el, hogy van-e valódi provider.
 */
export async function GET() {
  const falKey = (process.env.FAL_KEY ?? process.env.FAL_API_KEY ?? '').trim();
  const status = getPremiumConfigStatus(falKey);
  return NextResponse.json({
    provider: status === 'real' ? 'fal' : 'mock',
    mockActive: status !== 'real',
  });
}
