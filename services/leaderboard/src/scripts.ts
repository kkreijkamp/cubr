import type { Redis, Result } from 'ioredis';

// ---------------------------------------------------------------------------------------------
// Small Lua scripts so that "score + achievedAt (+ guard)" updates are atomic even when several
// leaderboard replicas process events for the same user concurrently. Registered with
// defineCommand (ioredis sends EVALSHA and falls back to EVAL), usable in pipelines too.
// ---------------------------------------------------------------------------------------------

/**
 * Keep-best write (weekly/daily/challenge boards).
 * KEYS: board, at-hash. ARGV: score, userId, achievedAt, ttlSec (0 = no TTL).
 * ZADD LT adds new members and only ever lowers existing scores; CH makes it return 1 when the
 * score changed, and only then is achievedAt updated. Returns 1 if the board changed.
 */
const BEST = `
local changed = redis.call('ZADD', KEYS[1], 'LT', 'CH', ARGV[1], ARGV[2])
if changed == 1 then redis.call('HSET', KEYS[2], ARGV[2], ARGV[3]) end
local ttl = tonumber(ARGV[4])
if ttl and ttl > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
end
return changed`;

/**
 * Exact write for all-time boards (a PB can also get worse or disappear after a delete).
 * KEYS: board, at-hash, ts-hash. ARGV: userId, score ('' = remove), achievedAt, occurredAtMs.
 * Events older than the last applied one for this user are ignored (replicas may process
 * stream entries slightly out of order). Returns 1 = set, 0 = removed, -1 = stale (ignored).
 */
const SET_PB = `
local prev = tonumber(redis.call('HGET', KEYS[3], ARGV[1]) or '0')
local ts = tonumber(ARGV[4])
if prev > ts then return -1 end
redis.call('HSET', KEYS[3], ARGV[1], ARGV[4])
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
    lbBest(board: string, at: string, score: number, userId: string, achievedAt: string, ttlSec: number): Result<number, Context>;
    lbSetPb(board: string, at: string, ts: string, userId: string, score: number | '', achievedAt: string, occurredAtMs: number): Result<number, Context>;
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
  redis.defineCommand('lbBest', { numberOfKeys: 2, lua: BEST });
  redis.defineCommand('lbSetPb', { numberOfKeys: 3, lua: SET_PB });
  redis.defineCommand('lbUser', { numberOfKeys: 1, lua: USER });
}
