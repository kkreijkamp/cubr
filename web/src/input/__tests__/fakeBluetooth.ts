// A pretend bluetooth device for the driver tests: services and characteristics that notify and
// answer writes the way a cube or timer does.

export class FakeCharacteristic extends EventTarget {
  value?: DataView;
  notifying = false;
  writes: number[][] = [];
  /** answers a write (the device's reply), or reads */
  onWrite: ((bytes: number[]) => void) | null = null;
  onRead: (() => number[]) | null = null;
  constructor(readonly uuid: string) {
    super();
  }
  async startNotifications() {
    this.notifying = true;
    return this as never;
  }
  async stopNotifications() {
    this.notifying = false;
    return this as never;
  }
  async writeValue(v: BufferSource) {
    const bytes = Array.from(
      v instanceof ArrayBuffer
        ? new Uint8Array(v)
        : new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength),
    );
    this.writes.push(bytes);
    this.onWrite?.(bytes);
  }
  async readValue() {
    const bytes = this.onRead?.() ?? [];
    return new DataView(new Uint8Array(bytes).buffer);
  }
  /** the device sends a notification */
  notify(bytes: number[]) {
    if (!this.notifying) throw new Error(`notify on ${this.uuid} before startNotifications`);
    this.value = new DataView(new Uint8Array(bytes).buffer);
    this.dispatchEvent(new Event('characteristicvaluechanged'));
  }
}

export class FakeService {
  constructor(
    readonly uuid: string,
    readonly chars: FakeCharacteristic[],
  ) {}
  async getCharacteristic(uuid: string) {
    const c = this.chars.find((x) => x.uuid.toLowerCase() === uuid.toLowerCase());
    if (!c) throw new Error(`no characteristic ${uuid}`);
    return c;
  }
  async getCharacteristics() {
    return this.chars;
  }
}

export class FakeDevice extends EventTarget {
  readonly id = 'fake';
  connected = false;
  gatt: {
    connected: boolean;
    connect: () => Promise<unknown>;
    disconnect: () => void;
    getPrimaryService: (u: string) => Promise<FakeService>;
    getPrimaryServices: () => Promise<FakeService[]>;
  };
  constructor(
    readonly name: string,
    readonly services: FakeService[],
    /** what watchAdvertisements reports (null: the browser can't) */
    readonly manufacturerData: Map<number, DataView> | null = null,
  ) {
    super();
    const self = this;
    this.gatt = {
      get connected() {
        return self.connected;
      },
      async connect() {
        self.connected = true;
        return self.gatt;
      },
      disconnect() {
        self.connected = false;
      },
      async getPrimaryService(u: string) {
        const s = self.services.find((x) => x.uuid.toLowerCase() === u.toLowerCase());
        if (!s) throw new Error(`no service ${u}`);
        return s;
      },
      async getPrimaryServices() {
        return self.services;
      },
    };
    if (manufacturerData) {
      (this as unknown as { watchAdvertisements: () => Promise<void> }).watchAdvertisements = async () => {
        setTimeout(() => {
          const e = new Event('advertisementreceived') as Event & { manufacturerData: Map<number, DataView> };
          Object.defineProperty(e, 'manufacturerData', { value: manufacturerData });
          this.dispatchEvent(e);
        }, 1);
      };
    }
  }
  /** the device switches off */
  drop() {
    this.connected = false;
    this.dispatchEvent(new Event('gattserverdisconnected'));
  }
}

export const tick = () => new Promise((r) => setTimeout(r, 5));
