import { clearAll } from '../../../../lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Booth admin reset. The credentials live on the SERVER, so the real check can't
// be bypassed by editing the page in a browser. Set ADMIN_USER / ADMIN_PASSWORD in
// Vercel to override the defaults — worth doing, because the fallback below is
// visible to anyone who reads this repository.
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'Dmatics@GISEC-2026';

// Constant-time-ish compare, so the endpoint doesn't leak length or prefix.
function same(a, b) {
  const x = String(a || ''), y = String(b || '');
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch (e) {
    return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
  }
  if (!same(body.user, USER) || !same(body.pass, PASS)) {
    // One deliberate second, so the password can't be brute-forced quickly.
    await new Promise((r) => setTimeout(r, 1000));
    return Response.json({ ok: false, error: 'Wrong username or password.' }, { status: 401 });
  }
  const res = await clearAll();
  return Response.json(
    { ok: true, ...res, message: 'All leaderboards cleared.' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
