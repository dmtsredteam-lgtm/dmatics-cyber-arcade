import { getScores, addScore, GAMES, isPersistent } from '../../../lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Leaderboard names: up to 12 characters. Uppercased for the arcade look, and
// restricted to letters/digits/space/._- so a name can never inject markup into
// the board. Mirrors cleanName() in public/game.html.
function clean(name) {
  const s = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ._-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12)
    .trim();
  return s || 'PLAYER';
}

// GET /api/scores?game=phish  ->  { game, scores:[{n,s,t}] }
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const game = searchParams.get('game');
  if (!GAMES.includes(game)) {
    return Response.json({ error: 'unknown game' }, { status: 400 });
  }
  const scores = await getScores(game);
  // `persistent` tells the client whether these scores actually survive a redeploy.
  // Without a KV database attached, the board is in-memory and will be lost — the
  // arcade says so on screen rather than quietly pretending the board is safe.
  return Response.json(
    { game, scores, persistent: await isPersistent() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

// POST /api/scores  { game, name, score }  ->  { game, scores }
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return Response.json({ error: 'bad json' }, { status: 400 });
  }
  const game = body.game;
  if (!GAMES.includes(game)) {
    return Response.json({ error: 'unknown game' }, { status: 400 });
  }
  const name = clean(body.name);
  let score = parseInt(body.score, 10);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(100000, score));
  const scores = await addScore(game, name, score);
  return Response.json(
    { game, scores, persistent: await isPersistent() },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
