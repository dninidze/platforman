/**
 * CHANGES_10 G1/G2: short synthesized sounds (Web Audio, no files). Nothing plays before the first user
 * interaction (browser autoplay rules); on by default, with a remembered on/off switch.
 */
const KEY = 'p3.sound';
let ctx: AudioContext | null = null;
let skipClick = false;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}
let enabled = read();

export const sound = {
  get on() {
    return enabled;
  },
  set on(v: boolean) {
    enabled = v;
    try {
      localStorage.setItem(KEY, v ? '1' : '0');
    } catch {
      /* storage blocked: keep for this page */
    }
  },
  /** Create / resume the audio context; call from a user gesture. */
  unlock() {
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx ??= new AC();
      if (ctx.state === 'suspended') void ctx.resume();
    } catch {
      ctx = null;
    }
  },
  /** One short click for every player action. */
  click() {
    if (skipClick) {
      skipClick = false;
      return;
    }
    tone([[1_800, 0, 0.035]], 'square', 0.05);
  },
  /** Bet placed: two rising notes. With fromTile, the tile tap's own click is skipped. */
  bet(fromTile = false) {
    skipClick = fromTile;
    tone([[660, 0, 0.09], [990, 0.08, 0.14]], 'triangle', 0.16);
  },
  /** Cash-out: a short rising arpeggio. */
  cashout() {
    tone([[784, 0, 0.08], [988, 0.07, 0.08], [1_319, 0.14, 0.2]], 'triangle', 0.18);
  },
};

/** Play notes [frequency Hz, start s, length s] with a quick attack and decay. */
function tone(notes: [number, number, number][], type: OscillatorType, peak: number) {
  if (!enabled || !ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  for (const [f, start, len] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(peak, now + start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + len);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + len + 0.02);
  }
}
