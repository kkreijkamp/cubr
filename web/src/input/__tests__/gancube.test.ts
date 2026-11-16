import { describe, expect, it } from 'vitest';
import { Aes128 } from '../bluetooth/aes128';
import { GAN_KEYS, macBytes, withMac } from '../bluetooth/keys';
import { ganCube } from '../bluetooth/cubes/gan';
import { tick } from './fakeBluetooth';
import { MAC, quarter, rng, SimGan } from './simGan';

async function connect(sim: SimGan) {
  const states: { facelet: string; moves: string[]; ts: [number | null, number | null]; puzzle?: string }[] = [];
  const battery: number[] = [];
  const connected: string[] = [];
  const model = ganCube();
  await model.init(
    sim.device as never,
    {
      state: (facelet: string, moves: string[], ts: [number | null, number | null], _d: string, puzzle?: '333' | '222') => states.push({ facelet, moves: moves.slice(), ts, puzzle }),
      battery: (l: number) => battery.push(l),
      mac: async () => MAC,
      connected: (f: string) => connected.push(f),
      log() {},
      lost() {},
    } as never,
    { waitForAdvertisement: () => Promise.reject(new Error('none')) } as never,
  );
  await tick();
  return { model, states, battery, connected };
}

describe('GAN smart cubes (a pretend cube, encrypted with the MAC-mixed key)', () => {
  for (const version of [2, 3, 4] as const) {
    it(`gen${version}: state, battery and every move, with lost messages recovered`, async () => {
      const r = rng(version * 31);
      const sim = new SimGan(version);
      for (let i = 0; i < 25; i++) sim.cube.move(quarter(r));
      const start = sim.cube.toFaceCube();
      const { states, battery, connected } = await connect(sim);
      // it asked for the facelets and battery, and took the cube's state
      expect(connected).toEqual([start]);
      expect(states[0].facelet).toBe(start);
      expect(battery).toEqual([77]);
      let lostCount = 0;
      for (let i = 0; i < 150; i++) {
        // (the last few get through: a lost last move only shows with the next message)
        const lost = i > 3 && i < 145 && r() < 0.12;
        if (lost) lostCount++;
        sim.turn(quarter(r), 80 + Math.floor(r() * 400), lost);
        await tick();
      }
      expect(lostCount).toBeGreaterThan(5);
      // every move reported once, in order, ending on the cube's real state
      const moved = states.slice(1);
      expect(moved.length).toBe(150);
      expect(states.at(-1)!.facelet).toBe(sim.cube.toFaceCube());
      // the latest move first in each report
      const all = [...sim.history.entries()].sort((a, b) => ((a[0] - 200) & 0xff) - ((b[0] - 200) & 0xff)).map((e) => e[1]);
      expect(moved.map((s) => s.moves[0])).toEqual(all);
      // gen3/4 asked for the history of the moves that got lost
      if (version !== 2) expect(sim.requests.some((q) => (version === 3 ? q[0] === 0x68 && q[1] === 3 : q[0] === 0xd1))).toBe(true);
    });
  }

  it('gen2: device times rebuilt from the gaps between moves', async () => {
    const sim = new SimGan(2);
    const { states } = await connect(sim);
    sim.turn('R ', 300, false);
    await tick();
    sim.turn('U ', 250, false);
    await tick();
    const [a, b] = states.slice(1).map((s) => s.ts[0]!);
    // the times start from performance.now(), a fraction, so the difference can be off by a rounding
    // (250.00000000000006): exact equality failed about one run in four
    expect(b - a).toBeCloseTo(250, 6);
  });

  it('gen4: the 251 UI 2x2 reports a 2x2', async () => {
    const sim = new SimGan(4, 'GAN251UI-xyz');
    // the 251 uses its own key
    sim.aes = new Aes128(withMac(GAN_KEYS[6], macBytes(MAC)));
    sim.aes.iv = withMac(GAN_KEYS[7], macBytes(MAC));
    const { states } = await connect(sim);
    sim.turn("R'", 200, false);
    await tick();
    expect(states.at(-1)).toMatchObject({ puzzle: '222', moves: ["R'"] });
  });

  it('asks for the MAC again when the data will not decode (a wrong key)', async () => {
    const sim = new SimGan(3);
    const asked: boolean[] = [];
    const model = ganCube();
    let tries = 0;
    await model.init(
      sim.device as never,
      {
        state() {},
        battery() {},
        mac: async (_n: string, _f: string | null, _s: string | null, opts?: { wrong?: boolean }) => {
          asked.push(Boolean(opts?.wrong));
          // the first time a wrong MAC
          return tries++ === 0 ? '11:22:33:44:55:66' : MAC;
        },
        connected() {},
        log() {},
        lost() {},
      } as never,
      { waitForAdvertisement: () => Promise.reject(new Error('none')) } as never,
    );
    await tick();
    // turning it: its messages decrypt to garbage under the wrong key; after three it asks again, saying so
    for (let i = 0; i < 4; i++) {
      sim.turn('R ', 200, false);
      await tick();
    }
    expect(asked).toEqual([false, true]);
  });
});
