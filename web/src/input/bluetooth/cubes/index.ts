// Every smart cube cubetype knows, as one bluetooth group (csTimer's GiikerCube).
import { BtGroup } from '../device';
import type { CubeCtx } from './context';
import { ganCube } from './gan';
import { otherCubes } from './others';

export function cubeGroup() {
  const o = otherCubes();
  const gan = ganCube();
  const models = [gan, o.giiker, o.gocube, o.moyu, o.moyu32, o.qiyi];
  const group = new BtGroup<CubeCtx>(models);
  /** the battery level of the connected cube, if it says */
  const battery = async (): Promise<number | null> => {
    const m = group.model as (typeof models)[number] | null;
    try {
      return m ? await m.battery() : null;
    } catch {
      return null;
    }
  };
  return { group, battery };
}
