// What a smart cube driver reports to the page (csTimer's GiikerCube.callback and giikerutil).

export interface CubeCtx {
  /**
   * the cube's state: URFDLB facelets, its latest moves (newest first), [device time, local time]
   * of the newest move (either may be null), the device name, and the puzzle ('222' for GAN's 2x2)
   */
  state(facelet: string, prevMoves: string[], ts: [number | null, number | null], device: string, puzzle?: '333' | '222'): void;
  battery(level: number, device: string): void;
  /** the cube's MAC address: found in its advertisement, else saved or asked for */
  mac(name: string, found: string | null, suggested: string | null, opts?: { force?: boolean; wrong?: boolean }): Promise<string | null>;
  /** the cube's first state after connecting (to offer resetting it to solved) */
  connected(facelet: string): void;
  log(...args: unknown[]): void;
  /** something went badly wrong with the stream: drop the connection */
  lost(): void;
}

/** the manufacturer data under one of `cics`, as the advertisement gives it (Bluefy: raw bytes, the company id first) */
export function manufacturerBytes(data: Map<number, DataView> | DataView, cics: number[], bluefySlice?: [number, number]): DataView | null {
  if (data instanceof DataView) return new DataView(data.buffer.slice(...(bluefySlice ?? [2, data.byteLength])));
  for (const id of cics) if (data.has(id)) return data.get(id)!;
  return null;
}

/** the bits of some bytes as a string, as csTimer parses the GAN and MoYu messages */
export const bitString = (bytes: number[]) => bytes.map((b) => (b + 256).toString(2).slice(1)).join('');
export const bits = (s: string, from: number, to: number) => parseInt(s.slice(from, to), 2);
