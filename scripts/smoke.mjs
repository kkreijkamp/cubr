#!/usr/bin/env node
// End-to-end smoke test through the public entry point (local gateway, kind gateway or GKE Ingress).
// Walks a real user journey across every microservice and checks the event pipeline, then cleans up
// after itself, also after a failed step: it deletes its race room and its throwaway account, and
// checks that the account's data left every service and every leaderboard. Nothing visible is left
// behind (only internal bookkeeping: the event log, which is trimmed, and the leaderboards' list of
// deleted accounts), so it can run against production:
//   node scripts/smoke.mjs http://localhost:8080
//   node scripts/smoke.mjs http://<INGRESS_IP>
const BASE = (process.argv[2] ?? process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
let token = null;
const PASSWORD = 'smoke-test-pw';
let username = null;
let userId = null;
/** the page of each 3x3 single board (all-time, daily, weekly) that listed the test account */
const boardPages = {};
/** the race room it made, until it's deleted */
let roomId = null;

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
  if (cond) console.log(`  ok ${name}${detail ? ` - ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ''}`);
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

console.log(`cubr smoke test -> ${BASE}\n`);

// the journey; deleteTestAccount() runs afterwards whatever happens
try {

console.log('health / info (every service answers through the entry point):');
for (const p of ['/_info', '/api/auth/_info', '/api/scrambles/_info', '/api/solves/_info', '/api/stats/_info', '/api/leaderboards/_info', '/api/race/_info', '/api/wca/_info']) {
  const r = await req('GET', p);
  check(p, r.status === 200, `${r.data?.service ?? '?'}@${r.data?.version ?? '?'} on ${r.data?.pod ?? '?'} (${r.ms} ms)`);
}
const internal = await req('GET', '/internal/users/00000000-0000-4000-8000-000000000000/solves');
check('/internal/* is NOT exposed publicly', internal.status === 404 || internal.status === 403, `status ${internal.status}`);

console.log('\nfrontend:');
const html = await fetch(BASE + '/leaderboards').then((r) => r.text());
check('SPA served for client routes', html.includes('<div id="root">'));

console.log('\nauth:');
username = `smoke_${Date.now().toString(36)}`;
const reg = await req('POST', '/api/auth/register', { username, email: `${username}@example.com`, password: PASSWORD });
check('register', reg.status === 201, `${username}`);
token = reg.data?.token;
const me = await req('GET', '/api/auth/me');
check('me', me.status === 200 && me.data?.user?.username === username);

console.log('\nscrambles:');
const sc = await req('GET', '/api/scrambles/333?count=3');
check('3x3 scrambles', sc.status === 200 && sc.data?.scrambles?.length === 3, `source=${sc.data?.source} (${sc.ms} ms)`);
const daily = await req('GET', '/api/scrambles/daily');
check('daily challenge scrambles', daily.status === 200 && Array.isArray(daily.data?.events?.['333']), daily.data?.date);

console.log('\nsolves -> event bus -> stats & leaderboard:');
const sessions = await req('GET', '/api/sessions');
const session = sessions.data?.sessions?.[0];
check('default session created', Boolean(session), session?.name);
check('default practice session created', (sessions.data?.sessions ?? []).some((s) => s.practice === true && s.event === session?.event), (sessions.data?.sessions ?? []).filter((s) => s.practice).map((s) => s.name).join(', '));
// Slow on purpose (about a minute each): a smoke run must not top the live leaderboards.
const times = [61234, 60456, 62001, 59876, 60987, 61500];
let lastRolling = null;
for (const t of times) {
  const r = await req('POST', '/api/solves', { id: crypto.randomUUID(), sessionId: session.id, timeMs: t, penalty: 'OK', scramble: sc.data?.scrambles?.[0] ?? "R U R' U'" });
  if (r.status !== 201) check('post solve', false, `status ${r.status} ${JSON.stringify(r.data)}`);
  lastRolling = r.data?.rolling;
}
check('6 solves saved, rolling ao5 computed', lastRolling?.ao5 > 0, `ao5=${lastRolling?.ao5}`);
userId = me.data?.user?.id;
await eventually('stats read model updated (single PB)', async () => {
  const s = await req('GET', `/api/stats/users/${userId}/summary`);
  const ev = s.data?.events?.find((e) => e.event === '333');
  return { ok: ev?.pbs?.single?.valueMs === 59876 && ev?.solves === 6, detail: `single=${ev?.pbs?.single?.valueMs} solves=${ev?.solves}` };
});
await eventually('leaderboard updated (all-time single)', async () => {
  const lb = await req('GET', '/api/leaderboards/333/single?period=all');
  if (lb.data?.me?.rank) boardPages.all = Math.ceil(lb.data.me.rank / 100);
  return { ok: lb.data?.me?.valueMs === 59876, detail: `rank=${lb.data?.me?.rank} of ${lb.data?.total}` };
});
for (const period of ['daily', 'weekly']) {
  await eventually(`${period} leaderboard updated`, async () => {
    const lb = await req('GET', `/api/leaderboards/333/single?period=${period}`);
    if (lb.data?.me?.rank) boardPages[period] = Math.ceil(lb.data.me.rank / 100);
    return { ok: lb.data?.me?.valueMs > 0, detail: `rank=${lb.data?.me?.rank}` };
  });
}

console.log('\nwca dataset:');
const meta = await req('GET', '/api/wca/meta');
if (meta.status === 503) {
  // a fresh stack has no WCA data until the import job ran (docker compose --profile jobs run --rm wca-import)
  console.log(`  - skipped: ${meta.data?.error?.message ?? 'WCA data not loaded'} (run the wca-import job first)`);
} else {
  check('wca meta', meta.status === 200, meta.status === 200 ? `export ${meta.data.exportDate}, persons=${meta.data.counts?.persons}` : `status ${meta.status}`);
  const rank = await req('GET', '/api/wca/rank?event=333&kind=single&value=59876&country=AU');
  check('where would I rank?', rank.status === 200, rank.status === 200 ? `world #${rank.data.world.rank} of ${rank.data.world.total} (${rank.data.world.percentile}%) - ${rank.ms} ms` : `status ${rank.status} ${rank.data?.error?.message ?? ''}`);
}

console.log('\nrace:');
const room = await req('POST', '/api/race/rooms', { name: 'smoke room', event: '333' });
check('create race room', room.status === 201, room.data?.room?.id);
roomId = room.data?.room?.id ?? null;
const rooms = await req('GET', '/api/race/rooms');
check('room listed in lobby', rooms.data?.rooms?.some((r) => r.id === roomId));
await deleteRoom();

console.log('\nload balancing (20 requests to /api/scrambles/_info):');
const pods = new Map();
await Promise.all(Array.from({ length: 20 }, async () => {
  const r = await req('GET', '/api/scrambles/_info');
  pods.set(r.data?.pod, (pods.get(r.data?.pod) ?? 0) + 1);
}));
check('requests spread over >= 1 pod', pods.size >= 1, [...pods].map(([p, n]) => `${p}:${n}`).join(' '));

console.log('\nsessions and logout:');
const sessDel = await req('DELETE', `/api/sessions/${session.id}`);
check('delete test session', sessDel.status === 204);
const out = await req('POST', '/api/auth/logout');
check('logout', out.status === 204);
const after = await req('GET', '/api/auth/me');
check('token revoked after logout', after.status === 401);
} catch (err) {
  check('the journey ran to the end', false, err.message);
} finally {
  await deleteTestAccount();
}

/** Deletes the race room (its creator, signed in, may) and checks it left the lobby. */
async function deleteRoom() {
  if (!roomId) return;
  const del = await req('DELETE', `/api/race/rooms/${roomId}`);
  if (del.status === 404 && /^Route DELETE/.test(del.data?.error?.message ?? '')) {
    // a server from before rooms could be deleted (v1.4.1)
    console.log('  - this server cannot delete race rooms yet: the room leaves the lobby after 10 empty minutes');
    roomId = null;
    return;
  }
  check('delete the race room', del.status === 204, `status ${del.status}`);
  const lobby = await req('GET', '/api/race/rooms');
  check('the room left the lobby', lobby.status === 200 && !(lobby.data?.rooms ?? []).some((r) => r.id === roomId));
  if (del.status === 204) roomId = null;
}

/** Deletes the throwaway account (signing in again if needed) and checks its data left every service. */
async function deleteTestAccount() {
  if (!username) return;
  console.log('\ncleanup (the race room, the test account and its data):');
  try {
    token = (await req('POST', '/api/auth/login', { login: username, password: PASSWORD })).data?.token ?? null;
    if (roomId) await deleteRoom(); // the journey stopped before it did
    const gone = await req('DELETE', '/api/auth/me', { password: PASSWORD });
    check('delete the test account', gone.status === 204, `status ${gone.status}`);
    check('its token stops working', (await req('GET', '/api/auth/me')).status === 401);
    token = null;
    check('its profile is gone', (await req('GET', `/api/users/${username}`)).status === 404);
    if (userId) {
      await eventually('its stats are gone', async () => {
        const s = await req('GET', `/api/stats/users/${userId}/summary`);
        const solves = (s.data?.events ?? []).reduce((n, e) => n + (e.solves ?? 0), 0);
        return { ok: s.status === 200 && solves === 0, detail: `${solves} solves left` };
      });
    }
    for (const [period, page] of Object.entries(userId ? boardPages : {})) {
      await eventually(`it left the ${period === 'all' ? 'all-time' : period} leaderboard`, async () => {
        const lb = await req('GET', `/api/leaderboards/333/single?period=${period}&size=100&page=${page}`);
        return { ok: lb.status === 200 && !(lb.data?.entries ?? []).some((e) => e.userId === userId), detail: `page ${page}` };
      });
    }
  } catch (err) {
    check('delete the test account', false, `${err.message} - delete ${username} by hand`);
  }
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
