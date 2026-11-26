// cubr seed job creates realistic synthetic cubers through the PUBLIC APIs, so the whole
// pipeline (solve -> outbox -> Redis Stream -> stats / leaderboard) is exercised exactly like real
// traffic. Runs as a Kubernetes Job (deploy/k8s) or `docker compose --profile jobs run seed`.
//
//   1. register (or log in to) N deterministic users + a demo account
//   2. bulk-import a year of practice history per user   (POST /api/sessions/import)
//   3. post a few "live" solves for today, one by one       (POST /api/solves -> daily/weekly boards)
//   4. let some users complete today's daily challenge      (5 x POST /api/solves with `daily`)
//
// Idempotent: users that already exist are logged in and skipped if they already have history.
import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

const AUTH_URL = process.env.AUTH_URL ?? 'http://auth:8080';
const SOLVE_URL = process.env.SOLVE_URL ?? 'http://solve:8080';
const SCRAMBLE_URL = process.env.SCRAMBLE_URL ?? 'http://scramble:8080';
const USERS = Number(process.env.SEED_USERS ?? 150);
const AVG_SOLVES = Number(process.env.SEED_AVG_SOLVES ?? 650);
const CONCURRENCY = Number(process.env.SEED_CONCURRENCY ?? 6);
const SEED = Number(process.env.SEED_RANDOM_SEED ?? 3208);
const PASSWORD_PREFIX = process.env.SEED_PASSWORD_PREFIX ?? 'seed-pass-';
const DEMO_USER = process.env.SEED_DEMO_USER ?? 'demo';
const DEMO_PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'cubr-demo';
// Lets auth skip its per-IP registration/login rate limits for this trusted job (all requests
// come from one pod IP). Must match auth's INTERNAL_API_TOKEN.
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN ?? '';

// ---------------------------------------------------------------- deterministic randomness
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(SEED);
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
/** standard normal via Box-Muller */
function gauss(): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- synthetic people
// prettier-ignore
const ADJ = ['swift', 'lazy', 'quiet', 'lucky', 'sly', 'turbo', 'mellow', 'crisp', 'neon', 'calm', 'rapid', 'sneaky', 'bold', 'tiny', 'cosmic', 'sleepy', 'zesty', 'fuzzy', 'brave', 'clever'];
// prettier-ignore
const NOUN = ['cuber', 'twister', 'fox', 'otter', 'corner', 'edge', 'ollie', 'pll', 'f2l', 'slice', 'turner', 'koala', 'magpie', 'wombat', 'panda', 'falcon', 'gecko', 'lynx', 'hawk', 'roux'];
// prettier-ignore
const COUNTRIES = ['AU', 'AU', 'AU', 'AU', 'NZ', 'US', 'US', 'GB', 'CA', 'DE', 'FR', 'NL', 'CN', 'JP', 'KR', 'IN', 'BR', 'PL', 'SE', 'SG', 'MY', 'PH', 'ID', 'ES'];
// prettier-ignore
const BIOS = ['cfop main, learning zbll', 'roux gang', 'sub-20 grind', 'oh enjoyer', 'just here for the daily', 'pyra is my comfort event', 'trying to get sub-10 this year', null, null, null];

/** event -> time multiplier relative to the user's 3x3 average, and how likely a user practises it */
const EVENT_PROFILE: Record<string, { mult: number; p: number; dnf: number }> = {
  '333': { mult: 1, p: 1, dnf: 0.012 },
  '222': { mult: 0.33, p: 0.55, dnf: 0.015 },
  '444': { mult: 3.3, p: 0.4, dnf: 0.015 },
  '555': { mult: 6.2, p: 0.18, dnf: 0.015 },
  '666': { mult: 11.5, p: 0.06, dnf: 0.02 },
  '777': { mult: 16.5, p: 0.05, dnf: 0.02 },
  '333oh': { mult: 1.9, p: 0.25, dnf: 0.015 },
  '333bf': { mult: 6.5, p: 0.07, dnf: 0.35 },
  clock: { mult: 0.65, p: 0.12, dnf: 0.03 },
  minx: { mult: 5.0, p: 0.12, dnf: 0.015 },
  pyram: { mult: 0.36, p: 0.35, dnf: 0.02 },
  skewb: { mult: 0.4, p: 0.3, dnf: 0.02 },
  sq1: { mult: 1.6, p: 0.12, dnf: 0.02 },
};

// ---------------------------------------------------------------- plausible (fake) scrambles
function movesFrom(faces: string[], suffixes: string[], n: number): string {
  const out: string[] = [];
  let last = '';
  while (out.length < n) {
    const f = pick(faces);
    if (f === last) continue;
    last = f;
    out.push(f + pick(suffixes));
  }
  return out.join(' ');
}
function fakeScramble(event: string): string {
  switch (event) {
    case '222':
      return movesFrom(['R', 'U', 'F'], ['', "'", '2'], 9);
    case '444':
      return movesFrom(['R', 'U', 'F', 'D', 'L', 'B', 'Rw', 'Uw', 'Fw'], ['', "'", '2'], 40);
    case '555':
    case '666':
    case '777':
      return movesFrom(['R', 'U', 'F', 'D', 'L', 'B', 'Rw', 'Uw', 'Fw', 'Dw', 'Lw', 'Bw'], ['', "'", '2'], event === '555' ? 60 : event === '666' ? 80 : 100);
    case 'pyram':
      return `${movesFrom(['R', 'U', 'L', 'B'], ['', "'"], 9)} ${pick(['', 'r ', "r' "])}${pick(['', 'u', "u'"])}`.trim();
    case 'skewb':
      return movesFrom(['R', 'U', 'L', 'B'], ['', "'"], 9);
    case 'clock':
      return 'UR3+ DR1- DL4+ UL2- U5+ R0+ D3- L1+ ALL2+ y2 U4- R2+ D1+ L3- ALL5+';
    case 'minx':
      return Array.from(
        { length: 7 },
        () => `${Array.from({ length: 5 }, () => `R${pick(['++', '--'])} D${pick(['++', '--'])}`).join(' ')} U${pick(['', "'"])}`,
      ).join('\n');
    case 'sq1':
      return Array.from({ length: 12 }, () => `(${Math.floor(rand() * 12) - 5},${Math.floor(rand() * 12) - 5})`).join(' / ');
    default:
      return movesFrom(['R', 'U', 'F', 'D', 'L', 'B'], ['', "'", '2'], 20);
  }
}

// ---------------------------------------------------------------- generated profile pictures
// A cube-face "identicon": a 3x3 grid of WCA sticker colours derived from the username, encoded
// as a PNG with node:zlib (no image libraries). Uploaded for most synthetic users so leaderboards
// and profiles show real pictures.
const STICKERS: [number, number, number][] = [
  [255, 255, 255],
  [255, 213, 0],
  [196, 30, 58],
  [255, 88, 0],
  [0, 81, 186],
  [0, 158, 96],
];

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

function cubeAvatarPng(seed: string, size = 128): Buffer {
  const h = createHash('sha256').update(seed).digest();
  const colors = Array.from({ length: 9 }, (_, i) => STICKERS[h[i] % STICKERS.length]);
  const bg: [number, number, number] = [35, 36, 39];
  const pad = Math.round(size * 0.08);
  const cell = (size - pad * 2) / 3;
  const gap = Math.max(2, Math.round(size * 0.03));
  const r = cell * 0.22; // sticker corner radius
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 + RGB
    for (let x = 0; x < size; x++) {
      let c = bg;
      const gx = Math.floor((x - pad) / cell);
      const gy = Math.floor((y - pad) / cell);
      if (gx >= 0 && gx < 3 && gy >= 0 && gy < 3) {
        // position inside the sticker (excluding the gap), with rounded corners
        const lx = x - pad - gx * cell - gap / 2;
        const ly = y - pad - gy * cell - gap / 2;
        const w = cell - gap;
        if (lx >= 0 && ly >= 0 && lx < w && ly < w) {
          const dx = Math.max(r - lx, 0, lx - (w - r));
          const dy = Math.max(r - ly, 0, ly - (w - r));
          if (dx * dx + dy * dy <= r * r) c = colors[gy * 3 + gx];
        }
      }
      row[1 + x * 3] = c[0];
      row[2 + x * 3] = c[1];
      row[3 + x * 3] = c[2];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

async function ensureAvatar(u: SeedUser, token: string): Promise<boolean> {
  const me = await call<{ user: { avatarUrl?: string | null } }>('GET', `${AUTH_URL}/api/auth/me`, undefined, token);
  if (me.status !== 200 || me.data.user.avatarUrl) return false;
  // ~60 % of synthetic users get a picture (deterministic per username); the demo account always does
  const roll = createHash('sha256').update(`avatar:${u.username}`).digest()[0] / 255;
  if (u.username !== DEMO_USER && roll > 0.6) return false;
  const res = await fetch(`${AUTH_URL}/api/auth/me/avatar`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png', authorization: `Bearer ${token}` },
    body: cubeAvatarPng(u.username),
    signal: AbortSignal.timeout(20_000),
  });
  return res.ok;
}

// ---------------------------------------------------------------- HTTP helpers
async function call<T>(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; data: T }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'x-timezone': 'Australia/Brisbane',
          ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(120_000),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : null;
      if (res.status >= 500 && attempt < 5) throw new Error(`HTTP ${res.status}`);
      return { status: res.status, data };
    } catch (err) {
      if (attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}

async function waitFor(url: string, name: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (i % 10 === 0) console.log(`waiting for ${name}...`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${name} did not become ready`);
}

// ---------------------------------------------------------------- per-user generation
interface SeedUser {
  username: string;
  email: string;
  password: string;
  country: string;
  displayName: string | null;
  bio: string | null;
  /** user's current 3x3 average in ms */
  base333: number;
  solves: number;
  events: string[];
  /** fraction of days in the last year with practice */
  activity: number;
}

function makeUsers(): SeedUser[] {
  rand = mulberry32(SEED);
  const users: SeedUser[] = [];
  const seen = new Set<string>([DEMO_USER]);
  for (let i = 0; users.length < USERS; i++) {
    let username = `${pick(ADJ)}${pick(NOUN)}`;
    if (rand() < 0.4) username += `_${Math.floor(rand() * 99)}`;
    if (seen.has(username)) continue;
    seen.add(username);
    // 3x3 average: log-normal around 20 s, clamped to [6.5 s, 75 s]
    const base333 = Math.min(75_000, Math.max(6_500, Math.exp(Math.log(20_000) + gauss() * 0.45)));
    const events = Object.entries(EVENT_PROFILE)
      .filter(([e, p]) => e === '333' || rand() < p.p * (base333 < 15_000 ? 1.6 : 1))
      .map(([e]) => e);
    users.push({
      username,
      email: `${username}@seed.cubr.dev`,
      password: `${PASSWORD_PREFIX}${i}`,
      country: pick(COUNTRIES),
      displayName: rand() < 0.5 ? username.replace(/_\d+$/, '').replace(/^\w/, (c) => c.toUpperCase()) : null,
      bio: pick(BIOS),
      base333,
      solves: Math.round(AVG_SOLVES * (0.3 + rand() * 1.4)),
      events,
      activity: 0.15 + rand() * 0.7,
    });
  }
  // the demo account: a committed sub-15 cuber with lots of history
  users.unshift({
    username: DEMO_USER,
    email: `${DEMO_USER}@cubr.dev`,
    password: DEMO_PASSWORD,
    country: 'AU',
    displayName: 'Demo Cuber',
    bio: 'the account used in the cubr demo - sub-13 3x3, learning 4x4 parity',
    base333: 12_600,
    solves: 2600,
    events: ['333', '222', '444', '333oh', 'pyram', 'skewb'],
    activity: 0.8,
  });
  return users;
}

interface ImportSolve {
  timeMs: number;
  penalty: 'OK' | '+2' | 'DNF';
  scramble: string;
  createdAt: string;
}

/** A year of practice: sessions of 5-40 solves on active days, steadily improving. */
function historyFor(u: SeedUser, event: string, count: number, endMs: number): ImportSolve[] {
  const prof = EVENT_PROFILE[event];
  const target = u.base333 * prof.mult; // average today
  const start = target * (1.12 + rand() * 0.35); // slower a year ago
  const days: number[] = [];
  for (let d = 365; d >= 1; d--) if (rand() < u.activity) days.push(d);
  if (days.length === 0) days.push(1);
  const perDay = Math.max(1, Math.round(count / days.length));
  const out: ImportSolve[] = [];
  for (const d of days) {
    const progress = 1 - d / 365;
    const mean = start + (target - start) * progress;
    const n = Math.max(1, Math.round(perDay * (0.4 + rand() * 1.2)));
    const hour = 6 + Math.floor(rand() * 17);
    let t = endMs - d * 86_400_000 + hour * 3_600_000 + Math.floor(rand() * 3_600_000) - 10 * 3_600_000;
    for (let k = 0; k < n && out.length < count; k++) {
      const time = Math.max(prof.mult * 900, Math.round(mean * Math.exp(gauss() * 0.11)));
      const r = rand();
      const penalty = r < prof.dnf ? 'DNF' : r < prof.dnf + 0.02 ? '+2' : 'OK';
      t += time + 8_000 + Math.floor(rand() * 20_000);
      out.push({ timeMs: time, penalty, scramble: fakeScramble(event), createdAt: new Date(t).toISOString() });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function login(u: SeedUser): Promise<{ token: string; created: boolean } | null> {
  const reg = await call<{ token: string }>('POST', `${AUTH_URL}/api/auth/register`, { username: u.username, email: u.email, password: u.password });
  if (reg.status === 201) {
    await call('PATCH', `${AUTH_URL}/api/auth/me`, { displayName: u.displayName, bio: u.bio, country: u.country }, reg.data.token);
    return { token: reg.data.token, created: true };
  }
  if (reg.status === 409 || reg.status === 429) {
    const res = await call<{ token: string }>('POST', `${AUTH_URL}/api/auth/login`, { login: u.username, password: u.password });
    if (res.status === 200) return { token: res.data.token, created: false };
    console.warn(`  ! cannot log in as ${u.username} (${res.status}) - skipping`);
    return null;
  }
  console.warn(`  ! register ${u.username} failed (${reg.status}) ${JSON.stringify(reg.data)}`);
  return null;
}

async function seedUser(u: SeedUser, idx: number, daily: Record<string, string[]> | null, today: string): Promise<number> {
  const auth = await login(u);

  if (!auth) return 0;

  const { token } = auth;
  let avatar = false;

  try {
    avatar = await ensureAvatar(u, token);
  } catch {
    // no picture for this one: the seed carries on without it
  }

  const sessions = await call<{ sessions: { id: string; event: string; solveCount: number }[] }>('GET', `${SOLVE_URL}/api/sessions`, undefined, token);
  const existing = sessions.data?.sessions ?? [];
  const already = existing.reduce((a, s) => a + s.solveCount, 0);
  let imported = 0;
  if (already < 20) {
    // 1) history import (one request per user)
    const now = Date.now();
    const shares = u.events.map((e) => (e === '333' ? 3 : 1));
    const totalShare = shares.reduce((a, b) => a + b, 0);
    const payload = {
      sessions: u.events.map((event, i) => ({
        name: event === '333' ? 'main' : 'practice',
        event,
        solves: historyFor(u, event, Math.max(12, Math.round((u.solves * shares[i]) / totalShare)), now),
      })),
    };
    const res = await call<{ imported: { solves: number } }>('POST', `${SOLVE_URL}/api/sessions/import`, payload, token);
    if (res.status !== 200 && res.status !== 201) console.warn(`  ! import for ${u.username} failed (${res.status}) ${JSON.stringify(res.data)}`);
    imported = res.data?.imported?.solves ?? 0;
  }

  // 2) a handful of live solves today -> solve.created events -> daily & weekly leaderboards
  const fresh = await call<{ sessions: { id: string; event: string; solveCount: number }[] }>('GET', `${SOLVE_URL}/api/sessions`, undefined, token);
  const all = fresh.data?.sessions ?? [];
  // The first GET /api/sessions auto-created an empty default "3x3" session; drop empty ones so the
  // imported history is what users see, and post new solves into the busiest session per event.
  for (const s of all.filter((x) => x.solveCount === 0 && all.some((y) => y.event === x.event && y.solveCount > 0))) {
    await call('DELETE', `${SOLVE_URL}/api/sessions/${s.id}`, undefined, token);
  }
  const busiest = (event: string) =>
    all.filter((s) => s.event === event && s.solveCount > 0).sort((a, b) => b.solveCount - a.solveCount)[0] ?? all.find((s) => s.event === event);
  const live = rand() < 0.6 || u.username === DEMO_USER ? Math.floor(3 + rand() * 9) : 0;
  const s333 = busiest('333');
  if (s333) {
    for (let k = 0; k < live; k++) {
      const time = Math.round(u.base333 * 0.97 * Math.exp(gauss() * 0.1));
      await call(
        'POST',
        `${SOLVE_URL}/api/solves`,
        {
          id: randomUUID(),
          sessionId: s333.id,
          timeMs: time,
          penalty: rand() < 0.02 ? '+2' : 'OK',
          scramble: fakeScramble('333'),
          source: 'timer',
          createdAt: new Date(Date.now() - (live - k) * 45_000).toISOString(),
        },
        token,
      );
    }
  }

  // 3) today's daily challenge for ~40 % of users (5 attempts -> daily.completed -> challenge board)
  if (daily && (rand() < 0.4 || u.username === DEMO_USER)) {
    for (const event of ['333', '222', 'pyram']) {
      const session = busiest(event);
      const scrambles = daily[event];
      if (!session || !scrambles) continue;
      const mult = EVENT_PROFILE[event].mult;
      for (let index = 0; index < 5; index++) {
        const res = await call(
          'POST',
          `${SOLVE_URL}/api/solves`,
          {
            id: randomUUID(),
            sessionId: session.id,
            timeMs: Math.round(u.base333 * mult * Math.exp(gauss() * 0.1)),
            penalty: rand() < 0.015 ? 'DNF' : 'OK',
            scramble: scrambles[index],
            source: 'daily',
            daily: { date: today, index },
          },
          token,
        );
        if (res.status === 409) break; // already done on a previous run
      }
    }
  }
  console.log(
    `  [${String(idx + 1).padStart(3)}] ${u.username.padEnd(20)} ${auth.created ? 'new ' : 'seen'} imported=${imported} live=${live}${avatar ? ' +avatar' : ''}`,
  );
  return imported + live;
}

async function main() {
  const t0 = Date.now();
  console.log(`cubr seed: ${USERS} users (+ demo), ~${AVG_SOLVES} solves each, concurrency ${CONCURRENCY}`);
  if (!INTERNAL_TOKEN) console.warn('INTERNAL_API_TOKEN not set - auth rate limits will cap how many users can be created');
  await waitFor(`${AUTH_URL}/readyz`, 'auth');
  await waitFor(`${SOLVE_URL}/readyz`, 'solve');

  const today = new Date().toISOString().slice(0, 10);
  let daily: Record<string, string[]> | null = null;
  try {
    const res = await call<{ events: Record<string, string[]> }>('GET', `${SCRAMBLE_URL}/api/scrambles/daily?date=${today}`);
    if (res.status === 200) daily = res.data.events;
  } catch {
    console.warn('scramble service unavailable - skipping daily challenge entries');
  }

  const users = makeUsers();
  let next = 0;
  let total = 0;
  async function worker() {
    while (next < users.length) {
      const i = next++;
      try {
        // await first: `total += await ...` reads total before the await, so the workers would
        // overwrite each other's counts
        const written = await seedUser(users[i], i, daily, today);
        total += written;
      } catch (err) {
        console.warn(`  ! ${users[i].username}: ${(err as Error).message}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`done: ${users.length} users, ${total} solves written in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  console.log(`demo login -> username "${DEMO_USER}" / password "${DEMO_PASSWORD}"`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
