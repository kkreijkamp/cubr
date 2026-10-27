// Finding and connecting a bluetooth device, csTimer's hardware/bluetooth.js: one group for smart
// cubes, one for timers, each a list of device models picked by name (the longest matching prefix),
// or by the services a nameless device offers.

export interface BtModel<C> {
  /** device name prefixes */
  prefix: string[];
  /** services to ask for access to */
  services: string[];
  /** services to look for when the device has no name we know (phone timer apps) */
  serviceFilters?: string[];
  /** manufacturer data company ids to ask for (the MAC address comes in it) */
  cics?: number[];
  init(device: BluetoothDevice, ctx: C, group: BtGroup<C>): Promise<void>;
  /** stop listening; `hardware`: the device went away by itself */
  clear(hardware: boolean): Promise<void>;
}

export class BluetoothError extends Error {}

const uuid128 = (u: string) => (/^[0-9a-f]{4}$/i.test(u) ? `0000${u}-0000-1000-8000-00805f9b34fb` : u).toLowerCase();

export function findUUID<T extends { uuid: string }>(list: T[], u: string): T | null {
  const want = uuid128(u);
  return list.find((x) => uuid128(x.uuid) === want) ?? null;
}

/** web bluetooth here at all (and switched on) */
export async function bluetoothAvailable(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.bluetooth) return false;
  if (!navigator.bluetooth.getAvailability) return true;
  try {
    return await navigator.bluetooth.getAvailability();
  } catch {
    return false;
  }
}

export class BtGroup<C> {
  device: BluetoothDevice | null = null;
  model: BtModel<C> | null = null;
  /** called when the device goes away (switched off, out of range) */
  onDisconnect: (() => void) | null = null;
  private readonly onGattDisconnect = () => {
    void this.disconnect(true).then(() => this.onDisconnect?.());
  };

  constructor(readonly models: BtModel<C>[]) {}

  get connected(): boolean {
    return this.device !== null;
  }

  /** ask the browser for a device (needs a click or key press) and set it up */
  async connect(ctx: C): Promise<string> {
    if (!(await bluetoothAvailable())) throw new BluetoothError('bluetooth is not available in this browser (try Chrome or Edge, with bluetooth on)');
    const filters: { namePrefix?: string; services?: string[] }[] = this.models.flatMap((m) => m.prefix.map((p) => ({ namePrefix: p })));
    for (const m of this.models) for (const s of m.serviceFilters ?? []) filters.push({ services: [s] });
    const device = await navigator.bluetooth!.requestDevice({
      filters,
      optionalServices: [...new Set(this.models.flatMap((m) => m.services))],
      optionalManufacturerData: [...new Set(this.models.flatMap((m) => m.cics ?? []))],
    });
    return this.setUp(device, ctx);
  }

  /** set up a device already granted (a reconnect needs no click) */
  async setUp(device: BluetoothDevice, ctx: C): Promise<string> {
    await this.disconnect(false);
    this.device = device;
    device.addEventListener('gattserverdisconnected', this.onGattDisconnect);
    let best: BtModel<C> | null = null;
    let bestLen = 0;
    for (const m of this.models) {
      for (const p of m.prefix) {
        if (device.name?.startsWith(p) && p.length > bestLen) {
          best = m;
          bestLen = p.length;
        }
      }
    }
    if (!best) {
      // no name we know: by the services it has
      const gatt = await device.gatt!.connect();
      const uuids = (await gatt.getPrimaryServices()).map((s) => uuid128(s.uuid));
      best = this.models.find((m) => (m.serviceFilters ?? []).some((s) => uuids.includes(uuid128(s)))) ?? null;
      if (!best) throw new BluetoothError("this device isn't one cubetype knows");
    }
    this.model = best;
    try {
      await best.init(device, ctx, this);
    } catch (e) {
      await this.disconnect(false);
      throw e;
    }
    return device.name ?? 'bluetooth device';
  }

  async disconnect(hardware: boolean): Promise<void> {
    const device = this.device;
    if (!device) return;
    this.device = null;
    device.removeEventListener('gattserverdisconnected', this.onGattDisconnect);
    try {
      await this.model?.clear(hardware);
    } catch {
      /* gone already */
    }
    try {
      device.gatt?.disconnect();
    } catch {
      /* gone already */
    }
    this.lastDevice = device;
  }

  /** the device last connected (for reconnecting without asking again) */
  lastDevice: BluetoothDevice | null = null;

  /**
   * The manufacturer data in the device's advertisements, which carries its MAC address on many
   * cubes. Needs watchAdvertisements (Chrome with experimental web platform features on); it never
   * fires on Linux and ChromeOS, so it gives up there at once, as csTimer does.
   */
  waitForAdvertisement(timeoutMs = 10_000): Promise<Map<number, DataView> | DataView> {
    const device = this.device;
    if (!device?.watchAdvertisements) return Promise.reject(new Error('no advertisements'));
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform;
    if (platform === 'Linux' || platform === 'Chrome OS') return Promise.reject(new Error('no advertisements here'));
    const abort = new AbortController();
    return new Promise((resolve, reject) => {
      const onAdv = (e: Event) => {
        const data = (e as BluetoothAdvertisingEvent).manufacturerData;
        // only some packets carry it (and some platforms split them): wait for one that does
        if (!data || data.size === 0) return;
        device.removeEventListener('advertisementreceived', onAdv);
        abort.abort();
        resolve(data);
      };
      device.addEventListener('advertisementreceived', onAdv);
      device.watchAdvertisements!({ signal: abort.signal }).catch(() => undefined);
      setTimeout(() => {
        device.removeEventListener('advertisementreceived', onAdv);
        abort.abort();
        reject(new Error('no advertisement with a MAC address'));
      }, timeoutMs);
    });
  }
}

/** the bytes of a characteristic value */
export const bytesOf = (v: DataView): number[] => Array.from({ length: v.byteLength }, (_, i) => v.getUint8(i));
