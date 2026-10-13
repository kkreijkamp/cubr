// Tiny side-effect helpers for the timer page: PB chime and clipboard copy.

let ctx: AudioContext | null = null;

/** A short, quiet rising arpeggio (C6 major) for a new personal best. */
export function playPbSound(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    [1046.5, 1318.5, 1568.0, 2093.0].forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const t = t0 + i * 0.075;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.07, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + (i === 3 ? 0.45 : 0.2));
      osc.connect(gain).connect(ctx!.destination);
      osc.start(t);
      osc.stop(t + 0.5);
    });
  } catch {
    /* audio unavailable */
  }
}

/** Copies text; falls back to a hidden textarea where the async clipboard API is unavailable (http). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** True on touch-first devices (phones/tablets): used for "tap" vs "press space" wording. */
export function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}
