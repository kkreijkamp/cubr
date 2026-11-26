// The microphone input a stackmat (or MoYu timer) is plugged into: raw samples, with every bit of
// processing the browser would do (echo cancelling, noise suppression, gain) turned off.

// collects 1024 samples at a time and hands them to the page (an AudioWorklet runs off the main
// thread). A file of its own, never inlined (Vite would make a small file a data: URL), so the CSP
// can keep scripts to cubr.dev's own files: no blob: or data: scripts.
import workletUrl from './stackmat.worklet.js?url&no-inline';

export interface Microphone {
  sampleRate: number;
  stop(): void;
}

export class MicrophoneError extends Error {
  constructor(
    message: string,
    readonly kind: 'unsupported' | 'denied' | 'suspended' | 'failed',
  ) {
    super(message);
  }
}

/**
 * Opens the microphone (`deviceId` '' = the default). Browsers only start audio after a click or key
 * press: without one this fails with kind 'suspended', and a "connect" button can try again.
 */
export async function openMicrophone(deviceId: string, onSamples: (s: Float32Array) => void, opts: { requireRunning?: boolean } = {}): Promise<Microphone> {
  if (typeof window === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof AudioContext === 'undefined') {
    throw new MicrophoneError('this browser has no microphone input', 'unsupported');
  }
  const ctx = new AudioContext();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
  } catch (e) {
    void ctx.close();
    const name = (e as Error).name;
    throw new MicrophoneError(
      name === 'NotAllowedError' || name === 'SecurityError' ? 'microphone access was blocked' : (e as Error).message || 'no microphone',
      name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'failed',
    );
  }
  if (ctx.state !== 'running') {
    await ctx.resume().catch(() => undefined);
    // (resume() changes the state; TypeScript can't see that)
    if ((ctx.state as AudioContextState) !== 'running' && opts.requireRunning !== false) {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
      throw new MicrophoneError('click to start listening', 'suspended');
    }
  }
  const source = ctx.createMediaStreamSource(stream);
  // a silent output keeps the graph running (nothing is played)
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);
  let node: AudioNode;
  try {
    await ctx.audioWorklet.addModule(workletUrl);
    const w = new AudioWorkletNode(ctx, 'cubr-stackmat', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    w.port.onmessage = (e: MessageEvent<Float32Array>) => onSamples(e.data);
    node = w;
  } catch {
    // older browsers: csTimer's ScriptProcessor
    const sp = ctx.createScriptProcessor(1024, 1, 1);
    sp.onaudioprocess = (e) => onSamples(e.inputBuffer.getChannelData(0).slice());
    node = sp;
  }
  source.connect(node);
  node.connect(mute);
  return {
    sampleRate: ctx.sampleRate,
    stop() {
      try {
        source.disconnect();
        node.disconnect();
      } catch {
        /* already gone */
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}

/** the audio inputs, for picking the one the timer is on (labels only after access was granted) */
export async function listMicrophones(): Promise<{ id: string; label: string }[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput').map((d, i) => ({ id: d.deviceId, label: d.label || `microphone ${i + 1}` }));
}
