import type { Redis, Result } from 'ioredis';

// ---------------------------------------------------------------------------------------------
// Small Lua scripts so that "score + achievedAt (+ guard)" updates are atomic even when several
// leaderboard replicas process events for the same user concurrently. Registered with
// defineCommand (ioredis sends EVALSHA and falls back to EVAL), usable in pipelines too.
// ---------------------------------------------------------------------------------------------

/**
 * Keep-best write (weekly/daily boards, from solve.created).
 * KEYS: board, at-hash, ts-hash. ARGV: score, userId, achievedAt, ttlSec (0 = no TTL), occurredAtMs.
 * ZADD LT adds new members and only ever lowers existing scores; CH makes it return 1 when the
 * score changed, and only then is achievedAt updated. Returns 1 if the board changed, 0 if not,
 * and -1 for a solve older than the last exact write (lbSetPeriod) for this user: that write
 * already knew of it, and it may have been deleted or penalised since.
 */
const BEST = `
local last = tonumber(redis.call('HGET', KEYS[3], ARGV[2]) or '0')
if last > tonumber(ARGV[5]) then return -1 end
local changed = redis.call('ZADD', KEYS[1], 'LT', 'CH', ARGV[1], ARGV[2])
if changed == 1 then redis.call('HSET', KEYS[2], ARGV[2], ARGV[3]) end
local ttl = tonumber(ARGV[4])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
end
return changed`;

/**
 * Records a value the anti-cheat refused on a weekly/daily board (from solve.created), so the API
 * can tell its owner why they aren't on it: the lowest one wins, like the board itself.
 * KEYS: flagged-hash, ts-hash. ARGV: userId, valueMs, flag JSON {valueMs, floorMs, achievedAt},
 * occurredAtMs, ttlSec. Ignored (-1) for a solve older than the last exact write (lbSetPeriod
 * knew of it already). Returns 1 if recorded, 0 if a lower one is there.
 */
const FLAG_BEST = `
local last = tonumber(redis.call('HGET', KEYS[2], ARGV[1]) or '0')
if last > tonumber(ARGV[4]) then return -1 end
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local ok, v = pcall(cjson.decode, cur)
  if ok and type(v) == 'table' and tonumber(v.valueMs) and tonumber(v.valueMs) <= tonumber(ARGV[2]) then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
local ttl = tonumber(ARGV[5])
if ttl and ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl) end
return 1`;

/**
 * Exact write for weekly/daily boards (periods.changed: stats' best of the day or week, which can
 * get worse or disappear after an edit or a delete).
 * KEYS: board, at-hash, ts-hash, flagged-hash. ARGV: userId, score ('' = none), achievedAt,
 * occurredAtMs, ttlSec, flag ('' = none, else JSON {valueMs, floorMs, achievedAt}: the best value
 * the anti-cheat refused there).
 * A write older than the last one applied for this user is ignored. The time is recorded even when
 * there is no score, so a late keep-best write of a deleted solve can't come back (see BEST).
 * Keys get the board's TTL only if they have none: re-reading an old day doesn't extend its life.
 * Returns 1 = set, 0 = no entry, -1 = stale (ignored).
 */
const SET_PERIOD = `
local last = tonumber(redis.call('HGET', KEYS[3], ARGV[1]) or '0')
if last > tonumber(ARGV[4]) then return -1 end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
local result = 0
if ARGV[2] == '' then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
else
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
  redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
  result = 1
end
if ARGV[6] == '' then
  redis.call('HDEL', KEYS[4], ARGV[1])
else
  redis.call('HSET', KEYS[4], ARGV[1], ARGV[6])
end
local ttl = tonumber(ARGV[5])
if ttl and ttl > 0 then
  for i = 1, 4 do
    if redis.call('TTL', KEYS[i]) == -1 then redis.call('EXPIRE', KEYS[i], ttl) end
  end
end
return result`;

/**
 * Exact write for all-time and daily-challenge boards (a PB can also get worse or disappear after a
 * delete). KEYS: board, at-hash, ts-hash, flagged-hash. ARGV: userId, score ('' = remove),
 * achievedAt, occurredAtMs, flag ('' = none).
 * Events older than the last applied one for this user are ignored (replicas may process
 * stream entries slightly out of order). A flag (JSON {valueMs, floorMs, achievedAt}: the anti-cheat
 * refused this value) is recorded for the user and leaves their entry as it was; any other write
 * clears it. Returns 1 = set, 0 = removed, 2 = flagged, -1 = stale (ignored).
 */
const SET_PB = `
local prev = tonumber(redis.call('HGET', KEYS[3], ARGV[1]) or '0')
local ts = tonumber(ARGV[4])
if prev > ts then return -1 end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
if ARGV[5] ~= '' then
  redis.call('HSET', KEYS[4], ARGV[1], ARGV[5])
  return 2
end
redis.call('HDEL', KEYS[4], ARGV[1])
if ARGV[2] == '' then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  return 0
end
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[3])
return 1`;

/**
 * Merge display info into lb:users. KEYS: users-hash. ARGV: userId, username, hasCountry ('1'/'0'),
 * country ('' = null). The country is only touched when the payload carried one (user.* events),
 * so solve/pb events (username only) keep it. Returns 1 if the hash was written.
 */
const USER = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
local obj = {}
if cur then
  local ok, v = pcall(cjson.decode, cur)
  if ok and type(v) == 'table' then obj = v end
end
local changed = (cur == false or cur == nil)
if obj.username ~= ARGV[2] then obj.username = ARGV[2]; changed = true end
if ARGV[3] == '1' then
  local c = cjson.null
  if ARGV[4] ~= '' then c = ARGV[4] end
  if obj.country ~= c then obj.country = c; changed = true end
end
if ARGV[5] == '1' then
  local a = cjson.null
  if ARGV[6] ~= '' then a = ARGV[6] end
  if obj.avatarUrl ~= a then obj.avatarUrl = a; changed = true end
end
if changed then
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(obj))
  return 1
end
return 0`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    lbBest(
      board: string,
      at: string,
      ts: string,
      score: number,
      userId: string,
      achievedAt: string,
      ttlSec: number,
      occurredAtMs: number,
    ): Result<number, Context>;
    lbFlagBest(flagged: string, ts: string, userId: string, valueMs: number, flag: string, occurredAtMs: number, ttlSec: number): Result<number, Context>;
    lbSetPeriod(
      board: string,
      at: string,
      ts: string,
      flagged: string,
      userId: string,
      score: number | '',
      achievedAt: string,
      occurredAtMs: number,
      ttlSec: number,
      flag: string,
    ): Result<number, Context>;
    lbSetPb(
      board: string,
      at: string,
      ts: string,
      flagged: string,
      userId: string,
      score: number | '',
      achievedAt: string,
      occurredAtMs: number,
      flag: string,
    ): Result<number, Context>;
    lbUser(
      users: string,
      userId: string,
      username: string,
      hasCountry: '0' | '1',
      country: string,
      hasAvatar: '0' | '1',
      avatarUrl: string,
    ): Result<number, Context>;
  }
}

export function defineScripts(redis: Redis): void {
  redis.defineCommand('lbBest', { numberOfKeys: 3, lua: BEST });
  redis.defineCommand('lbFlagBest', { numberOfKeys: 2, lua: FLAG_BEST });
  redis.defineCommand('lbSetPeriod', { numberOfKeys: 4, lua: SET_PERIOD });
  redis.defineCommand('lbSetPb', { numberOfKeys: 4, lua: SET_PB });
  redis.defineCommand('lbUser', { numberOfKeys: 1, lua: USER });
}
