#!/usr/bin/env node
// End-to-end smoke test through the public entry point (the docker compose gateway by default).
// Walks a real user journey across the microservices and checks the event pipeline:
//   node scripts/smoke.mjs http://localhost:8080
const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let token = null;

async function req(method, path, body) {
  const t = Date.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'x-timezone': 'Australia/Brisbane',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, ms: Date.now() - t, pod: res.headers.get('x-served-by') };
}

function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function eventually(name, fn, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last.ok) return check(name, true, last.detail);
    } catch (e) {
      last = { detail: e.message };
    }
    await sleep(500);
  }
  check(name, false, last?.detail ?? 'timed out');
}

console.log(`cubetype smoke test → ${BASE}\n`);

console.log('health / info (every service answers through the entry point):');
for (const p of ['/api/auth/_info', '/api/scrambles/_info', '/api/solves/_info', '/api/stats/_info', '/api/leaderboards/_info']) {
  const r = await req('GET', p);
  check(p, r.status === 200, `${r.data?.service ?? '?'}@${r.data?.version ?? '?'} on ${r.data?.pod ?? '?'} (${r.ms} ms)`);
}
const internal = await req('GET', '/internal/users/00000000-0000-4000-8000-000000000000/solves');
check('/internal/* is NOT exposed publicly', internal.status === 404 || internal.status === 403, `status ${internal.status}`);

console.log('\nfrontend:');
const html = await fetch(BASE + '/leaderboards').then((r) => r.text());
check('SPA served for client routes', html.includes('<div id="root">'));

console.log('\nauth:');
const username = `smoke_${Date.now().toString(36)}`;
const reg = await req('POST', '/api/auth/register', { username, email: `${username}@example.com`, password: 'smoke-test-pw' });
check('register', reg.status === 201, `${username}`);
token = reg.data?.token;
const me = await req('GET', '/api/auth/me');
check('me', me.status === 200 && me.data?.user?.username === username);

console.log('\nscrambles:');
const sc = await req('GET', '/api/scrambles/333?count=3');
check('3x3 scrambles', sc.status === 200 && sc.data?.scrambles?.length === 3, `source=${sc.data?.source} (${sc.ms} ms)`);

console.log('\nsolves → event bus → stats & leaderboard:');
const sessions = await req('GET', '/api/sessions');
const session = sessions.data?.sessions?.[0];
check('default session created', Boolean(session), session?.name);
const times = [11234, 10456, 12001, 9876, 10987, 11500];
let lastRolling = null;
for (const t of times) {
  const r = await req('POST', '/api/solves', { id: crypto.randomUUID(), sessionId: session.id, timeMs: t, penalty: 'OK', scramble: sc.data?.scrambles?.[0] ?? "R U R' U'" });
  if (r.status !== 201) check('post solve', false, `status ${r.status} ${JSON.stringify(r.data)}`);
  lastRolling = r.data?.rolling;
}
check('6 solves saved, rolling ao5 computed', lastRolling?.ao5 > 0, `ao5=${lastRolling?.ao5}`);
const userId = me.data?.user?.id;
await eventually('stats read model updated (single PB)', async () => {
  const s = await req('GET', `/api/stats/users/${userId}/summary`);
  const ev = s.data?.events?.find((e) => e.event === '333');
  return { ok: ev?.pbs?.single?.valueMs === 9876 && ev?.solves === 6, detail: `single=${ev?.pbs?.single?.valueMs} solves=${ev?.solves}` };
});
await eventually('leaderboard updated (all-time single)', async () => {
  const lb = await req('GET', '/api/leaderboards/333/single?period=all');
  return { ok: lb.data?.me?.valueMs === 9876, detail: `rank=${lb.data?.me?.rank} of ${lb.data?.total}` };
});
await eventually('daily leaderboard updated', async () => {
  const lb = await req('GET', '/api/leaderboards/333/single?period=daily');
  return { ok: lb.data?.me?.valueMs > 0, detail: `rank=${lb.data?.me?.rank}` };
});

console.log('\ncleanup:');
const sessDel = await req('DELETE', `/api/sessions/${session.id}`);
check('delete test session', sessDel.status === 204);
const out = await req('POST', '/api/auth/logout');
check('logout', out.status === 204);
const after = await req('GET', '/api/auth/me');
check('token revoked after logout', after.status === 401);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed ✓');
process.exit(failures ? 1 : 0);
