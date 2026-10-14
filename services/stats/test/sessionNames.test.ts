import { afterEach, describe, expect, it, vi } from 'vitest';
import { startSessionNameBackfill } from '../src/sessionNames.js';

const U = '00000000-0000-4000-8000-000000000001';
const S1 = '11111111-1111-4111-8111-111111111111';

function fakeLog() {
  return { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('session name backfill', () => {
  it('keeps running (and never rejects) while Postgres is unreachable', async () => {
    vi.useFakeTimers();
    const log = fakeLog();
    const connect = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const stop = startSessionNameBackfill({ pool: { connect } as never, solveUrl: 'http://solve', internalToken: '', log: log as never });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(connect).toHaveBeenCalledTimes(2); // the next pass is still scheduled
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('discards a client whose query failed', async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    const client = { query: vi.fn().mockRejectedValue(new Error('connection terminated')), release };
    const stop = startSessionNameBackfill({
      pool: { connect: vi.fn().mockResolvedValue(client) } as never,
      solveUrl: 'http://solve',
      internalToken: 'secret',
      log: fakeLog() as never,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(release).toHaveBeenCalledWith(expect.any(Error));
    stop();
  });

  it('only inserts missing names (a newer rename is never overwritten) and sends the internal token', async () => {
    vi.useFakeTimers();
    const sql: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        sql.push(text);
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ ok: true }] };
        if (text.includes('SELECT DISTINCT l.user_id')) return { rows: [{ user_id: U }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ sessions: [{ id: S1, name: 'Main', event: '333' }] })));
    vi.stubGlobal('fetch', fetchMock);
    const stop = startSessionNameBackfill({
      pool: { connect: vi.fn().mockResolvedValue(client) } as never,
      solveUrl: 'http://solve',
      internalToken: 'secret',
      log: fakeLog() as never,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const inserts = sql.filter((s) => s.includes('INSERT INTO stats.sessions'));
    expect(inserts).toHaveLength(2);
    for (const s of inserts) expect(s).toContain('ON CONFLICT (session_id) DO NOTHING');
    expect(client.release).toHaveBeenCalledWith(undefined);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ 'x-internal-token': 'secret' });
    stop();
  });
});
