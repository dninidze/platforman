/**
 * Background music: three original minimal / deep-house loops (120 BPM), synthesized live with the
 * Web Audio API (no files, no network). Kept low in the mix, under the game sounds.
 *
 * Usage: music.start(ctx, 'a') from (or after) a user gesture, with the AudioContext owned by sound.ts.
 * A lookahead scheduler (25 ms timer, 0.12 s window) queues notes on ctx.currentTime; every voice
 * disconnects its nodes when its source ends, and the bus is torn down after the stop fade.
 *
 * Each loop is 16 bars (8 chord slots x 2 bars). Bar 8 has a small drum fill; bars 13-16 close a
 * master low-pass sweep with a noise riser and a drum break, and the filter re-opens on the downbeat.
 */

export type MusicTrack = 'a' | 'b' | 'c';

export const MUSIC_TRACKS: { id: MusicTrack; name: string }[] = [
  // CHANGES_11 M3: Glasshouse first and the default.
  { id: 'c', name: 'Glasshouse' },
  { id: 'a', name: 'Velvet Hours' },
  { id: 'b', name: 'Undertow' },
];

/* ------------------------------------------------------------------ patterns */

interface Synth {
  wave: OscillatorType;
  /** Cents of spread for a second detuned oscillator; 0 = single oscillator. */
  detune: number;
  cutoff: number;
  /** Extra filter cutoff at note-on, decaying to `cutoff`. */
  env: number;
  fdecay: number;
  q: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  gain: number;
  /** Amount sent to the echo bus. */
  send: number;
}

interface TrackDef {
  bpm: number;
  /** Delay of every odd 16th, as a fraction of one 16th. */
  swing: number;
  /** Drum lanes, indexed by step modulo their length. kick/clap: 'x'; hat: 'c' closed, 'o' open; perc: 's' shaker, 'r' rim. */
  kick: string;
  hat: string;
  clap: string;
  perc: string;
  hatLevel: number;
  clapLevel: number;
  /** 8 chord slots of 2 bars each (MIDI notes), with the bass root for each slot. */
  chords: number[][];
  roots: number[];
  /** 32 steps. r = root, f = fifth, o = octave, '-' = hold previous, '.' = rest. */
  bass: string;
  bassSynth: Synth;
  stab?: { pattern: string; len: number; synth: Synth };
  pad?: Synth;
  /** 32 steps; digits index into the current chord, '.' = rest. */
  arp?: { pattern: string; octave: number; synth: Synth };
  sweepLow: number;
  echoSteps: number;
  echoFeedback: number;
  echoLevel: number;
}

const TRACKS: Record<MusicTrack, TrackDef> = {
  // Warm swung chord stabs in D minor over a round bass, soft pad underneath.
  a: {
    bpm: 120,
    swing: 0.14,
    kick: 'x...x...x...x...',
    hat: '..o...o...o...o.',
    clap: '....x.......x...',
    perc: '.s.s.s.s.s.s.sr.',
    hatLevel: 0.09,
    clapLevel: 0.2,
    chords: [
      [53, 57, 60, 64], // Dm9
      [50, 53, 57, 60], // Bbmaj9
      [53, 57, 58, 62], // Gm9
      [52, 55, 57, 62], // A7sus4
      [53, 57, 60, 64], // Dm9
      [52, 57, 60, 65], // Fmaj7
      [55, 57, 58, 62], // Ebmaj7#11
      [52, 55, 57, 61], // A7
    ],
    roots: [38, 34, 43, 33, 38, 41, 39, 33],
    bass: '..r-..r.....o-....r-..r...f-..o.',
    bassSynth: { wave: 'triangle', detune: 0, cutoff: 420, env: 300, fdecay: 0.08, q: 1, attack: 0.005, decay: 0.22, sustain: 0.35, release: 0.06, gain: 0.34, send: 0 },
    stab: {
      pattern: '..x...x....x..x...x...x...x.....',
      len: 2,
      synth: { wave: 'sawtooth', detune: 9, cutoff: 650, env: 1900, fdecay: 0.07, q: 4, attack: 0.004, decay: 0.12, sustain: 0, release: 0.08, gain: 0.05, send: 0.35 },
    },
    pad: { wave: 'triangle', detune: 6, cutoff: 900, env: 0, fdecay: 1, q: 0.7, attack: 1.2, decay: 3, sustain: 0.6, release: 1, gain: 0.022, send: 0.2 },
    sweepLow: 700,
    echoSteps: 3,
    echoFeedback: 0.32,
    echoLevel: 0.35,
  },
  // Darker C minor: rolling 16th saw bass, rimshots, a sparse resonant stab and a low pad.
  b: {
    bpm: 120,
    swing: 0.08,
    kick: 'x...x...x...x...',
    hat: '..c...c...c...c...c...c...c.c.o.',
    clap: '....x.......x...',
    perc: '.s.r.s.s.s.r.ss.',
    hatLevel: 0.08,
    clapLevel: 0.16,
    chords: [
      [55, 58, 62, 63], // Cm9
      [55, 58, 62, 63], // Cm9
      [55, 60, 63, 67], // Abmaj7
      [56, 60, 63, 67], // Fm9
      [55, 58, 62, 63], // Cm9
      [55, 58, 62, 65], // Cm11
      [56, 60, 61, 65], // Dbmaj7
      [53, 58, 62, 65], // Gm7
    ],
    roots: [36, 36, 32, 41, 36, 36, 37, 31],
    bass: '..rr.rr.ro.r.rr...rr.rr.rf.r.of.',
    bassSynth: { wave: 'sawtooth', detune: 0, cutoff: 200, env: 900, fdecay: 0.06, q: 6, attack: 0.003, decay: 0.09, sustain: 0.2, release: 0.04, gain: 0.2, send: 0 },
    stab: {
      pattern: '...........x..........x.........',
      len: 3,
      synth: { wave: 'square', detune: 5, cutoff: 480, env: 1300, fdecay: 0.12, q: 8, attack: 0.004, decay: 0.25, sustain: 0, release: 0.2, gain: 0.035, send: 0.6 },
    },
    pad: { wave: 'sawtooth', detune: 12, cutoff: 420, env: 0, fdecay: 1, q: 1, attack: 2, decay: 4, sustain: 0.7, release: 1.5, gain: 0.02, send: 0.15 },
    sweepLow: 450,
    echoSteps: 3,
    echoFeedback: 0.4,
    echoLevel: 0.3,
  },
  // Light E major / C# minor: dotted pluck arpeggio with echo, soft sine sub, airy pad.
  c: {
    bpm: 120,
    swing: 0.12,
    kick: 'x...x...x...x...',
    hat: '..c...c...c...c...c..cc...c...o.',
    clap: '....x.......x...',
    perc: '......r.......r.',
    hatLevel: 0.07,
    clapLevel: 0.13,
    chords: [
      [59, 61, 64, 68], // Amaj9
      [56, 59, 63, 66], // Emaj9/G#
      [59, 63, 64, 68], // C#m9
      [59, 64, 66, 69], // Bsus4
      [59, 61, 64, 68], // Amaj9
      [56, 59, 63, 66], // G#m7
      [57, 61, 64, 71], // F#m11
      [59, 64, 66, 69], // Bsus4
    ],
    roots: [33, 32, 37, 35, 33, 32, 30, 35],
    bass: '...r......r..r.....r......r.o.f.',
    bassSynth: { wave: 'sine', detune: 0, cutoff: 1800, env: 0, fdecay: 0.1, q: 0.5, attack: 0.006, decay: 0.3, sustain: 0.5, release: 0.1, gain: 0.36, send: 0 },
    arp: {
      pattern: '0..2..1..3..2..1..0..3..2..1..3.',
      octave: 12,
      synth: { wave: 'square', detune: 0, cutoff: 1300, env: 2600, fdecay: 0.06, q: 2, attack: 0.002, decay: 0.16, sustain: 0, release: 0.1, gain: 0.045, send: 0.55 },
    },
    pad: { wave: 'triangle', detune: 8, cutoff: 1300, env: 0, fdecay: 1, q: 0.5, attack: 1.5, decay: 3, sustain: 0.7, release: 1.2, gain: 0.018, send: 0.3 },
    sweepLow: 1100,
    echoSteps: 3,
    echoFeedback: 0.38,
    echoLevel: 0.4,
  },
};

const BASS_INTERVALS: Record<string, number> = { r: 0, f: 7, o: 12 };
const LOOP_BARS = 16;
const MASTER_LEVEL = 0.12;
const LOOKAHEAD = 0.12;
const TICK_MS = 25;
const SWEEP_OPEN = 16000;

/* ------------------------------------------------------------------ engine state */

interface Bus {
  ctx: AudioContext;
  master: GainNode;
  sweep: BiquadFilterNode;
  mix: GainNode;
  send: GainNode;
  echo: DelayNode;
  nodes: AudioNode[];
}

let bus: Bus | null = null;
let timer: number | null = null;
let current: MusicTrack = 'a';
let pending: MusicTrack | null = null;
let step = 0;
let nextTime = 0;
const noiseCache = new WeakMap<AudioContext, AudioBuffer>();

function mtof(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function stepDur(def: TrackDef): number {
  return 60 / def.bpm / 4;
}

function noise(ctx: AudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    const len = Math.floor(ctx.sampleRate * 1.5);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(ctx, buf);
  }
  return buf;
}

/** Disconnect every node of a voice once its (last) source has ended. */
function cleanup(src: AudioScheduledSourceNode, nodes: AudioNode[]): void {
  src.onended = () => {
    for (const n of nodes) n.disconnect();
  };
}

/**
 * CHANGES_11 M1: light mode for phones and tablets (coarse pointer, or ?lite=1): no sustained pad layer and no
 * echo sends, which roughly halves the audio work. Desktop keeps the full arrangement.
 */
const LITE =
  typeof window !== 'undefined' &&
  ((typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches) || /[?&]lite=1/.test(window.location.search));

/* ------------------------------------------------------------------ instruments */

function tone(b: Bus, t: number, midi: number, dur: number, s: Synth): void {
  const { ctx } = b;
  const f = mtof(midi);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.Q.value = s.q;
  filt.frequency.setValueAtTime(s.cutoff + s.env, t);
  if (s.env > 0) filt.frequency.setTargetAtTime(s.cutoff, t, s.fdecay);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(s.gain, t + s.attack);
  g.gain.setTargetAtTime(s.gain * s.sustain, t + s.attack, s.decay);
  const off = Math.max(t + s.attack, t + dur);
  g.gain.setTargetAtTime(0, off, s.release);
  const end = off + s.release * 4; // CHANGES_11 M1: shorter tails (inaudible below -35 dB)
  filt.connect(g);
  g.connect(b.mix);
  const nodes: AudioNode[] = [filt, g];
  if (s.send > 0 && !LITE) {
    const sg = ctx.createGain();
    sg.gain.value = s.send;
    g.connect(sg);
    sg.connect(b.send);
    nodes.push(sg);
  }
  // CHANGES_11 M1: one oscillator per voice (the detuned second oscillator doubled the cost); a light detune keeps some width.
  const spreads = [s.detune > 0 ? s.detune / 2 : 0];
  let last: OscillatorNode | null = null;
  for (const c of spreads) {
    const o = ctx.createOscillator();
    o.type = s.wave;
    o.frequency.value = f;
    o.detune.value = c;
    o.connect(filt);
    o.start(t);
    o.stop(end);
    nodes.push(o);
    last = o;
  }
  if (last) cleanup(last, nodes);
}

function kick(b: Bus, t: number, level: number): void {
  const { ctx } = b;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(43, t + 0.11);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(level, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  o.connect(g);
  g.connect(b.mix);
  o.start(t);
  o.stop(t + 0.45);
  cleanup(o, [o, g]);
}

function noiseHit(b: Bus, t: number, dur: number, level: number, type: BiquadFilterType, freq: number, q: number): void {
  const { ctx } = b;
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const filt = ctx.createBiquadFilter();
  filt.type = type;
  filt.frequency.value = freq;
  filt.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(level, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt);
  filt.connect(g);
  g.connect(b.mix);
  src.start(t, Math.random() * 1.2, dur + 0.02);
  cleanup(src, [src, filt, g]);
}

function clap(b: Bus, t: number, level: number): void {
  const { ctx } = b;
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const filt = ctx.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = 1250;
  filt.Q.value = 1.1;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  for (const d of [0, 0.011, 0.022]) {
    g.gain.setValueAtTime(level, t + d);
    g.gain.exponentialRampToValueAtTime(level * 0.25, t + d + 0.009);
  }
  g.gain.setValueAtTime(level * 0.8, t + 0.032);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  src.connect(filt);
  filt.connect(g);
  g.connect(b.mix);
  const sg = ctx.createGain();
  sg.gain.value = 0.25;
  g.connect(sg);
  sg.connect(b.send);
  src.start(t, Math.random() * 1.2, 0.25);
  cleanup(src, [src, filt, g, sg]);
}

function rim(b: Bus, t: number, level: number): void {
  const { ctx } = b;
  const o = ctx.createOscillator();
  o.type = 'triangle';
  o.frequency.value = 1700;
  const g = ctx.createGain();
  g.gain.setValueAtTime(level, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
  o.connect(g);
  g.connect(b.mix);
  const sg = ctx.createGain();
  sg.gain.value = 0.4;
  g.connect(sg);
  sg.connect(b.send);
  o.start(t);
  o.stop(t + 0.05);
  cleanup(o, [o, g, sg]);
}

function riser(b: Bus, t: number, dur: number, level: number): void {
  const { ctx } = b;
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  src.loop = true;
  const filt = ctx.createBiquadFilter();
  filt.type = 'bandpass';
  filt.Q.value = 2;
  filt.frequency.setValueAtTime(700, t);
  filt.frequency.exponentialRampToValueAtTime(6000, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(level, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.03);
  src.connect(filt);
  filt.connect(g);
  g.connect(b.mix);
  src.start(t);
  src.stop(t + dur + 0.05);
  cleanup(src, [src, filt, g]);
}

/* ------------------------------------------------------------------ sequencer */

function applyEcho(b: Bus, def: TrackDef): void {
  b.echo.delayTime.setValueAtTime(stepDur(def) * def.echoSteps, b.ctx.currentTime);
}

function scheduleStep(b: Bus, def: TrackDef, s: number, t0: number): void {
  const sd = stepDur(def);
  const inBar = s % 16;
  const bar = Math.floor(s / 16) % LOOP_BARS;
  const two = s % 32;
  const slot = Math.floor(bar / 2) % def.chords.length;
  const t = t0 + (s % 2 === 1 ? def.swing * sd : 0);
  const chord = def.chords[slot];
  const root = def.roots[slot];
  const fill8 = bar === 7 && inBar >= 12;
  const brk = bar === 15 && inBar >= 8;

  // Master sweep: close over bars 13-16, snap open on the loop downbeat.
  if (inBar === 0 && bar === 12) {
    b.sweep.frequency.cancelScheduledValues(t0);
    b.sweep.frequency.setValueAtTime(SWEEP_OPEN, t0);
    b.sweep.frequency.exponentialRampToValueAtTime(def.sweepLow, t0 + sd * 16 * 4);
  } else if (inBar === 0 && bar === 0) {
    b.sweep.frequency.cancelScheduledValues(t0);
    b.sweep.frequency.setValueAtTime(Math.max(def.sweepLow, Math.min(SWEEP_OPEN, b.sweep.frequency.value)), t0);
    b.sweep.frequency.exponentialRampToValueAtTime(SWEEP_OPEN, t0 + sd * 2);
  }
  if (bar === 15 && inBar === 8) riser(b, t0, sd * 8, 0.06);

  // Drums.
  if (def.kick[s % def.kick.length] === 'x' && !brk && !(fill8 && inBar === 12)) kick(b, t, 0.85);
  const h = def.hat[s % def.hat.length];
  const human = 0.85 + Math.random() * 0.3;
  if (brk) {
    noiseHit(b, t, 0.04, def.hatLevel * (0.4 + (inBar - 8) * 0.1), 'highpass', 8000, 0.7);
  } else if (h === 'c') {
    noiseHit(b, t, 0.045, def.hatLevel * human, 'highpass', 8000, 0.7);
  } else if (h === 'o' || (fill8 && inBar === 14)) {
    noiseHit(b, t, 0.16, def.hatLevel * human, 'highpass', 7000, 0.7);
  }
  const p = def.perc[s % def.perc.length];
  if (p === 's') noiseHit(b, t, 0.03, def.hatLevel * 0.35 * human, 'highpass', 5500, 1);
  else if (p === 'r') rim(b, t, 0.05);
  if (def.clap[s % def.clap.length] === 'x' || (fill8 && inBar === 15) || (brk && (inBar === 14 || inBar === 15))) {
    clap(b, t, def.clapLevel * (brk && inBar !== 12 ? 0.7 : 1));
  }

  // Bass.
  const bc = def.bass[two % def.bass.length];
  const iv = BASS_INTERVALS[bc];
  if (iv !== undefined && !(brk && inBar >= 12)) {
    let len = 1;
    while (def.bass[(two + len) % def.bass.length] === '-' && len < 16) len++;
    tone(b, t, root + iv, len * sd * 0.9, def.bassSynth);
  }

  // Pad: one long chord per 2-bar slot.
  if (def.pad && two === 0 && !LITE) {
    for (const n of chord) tone(b, t, n, sd * 30, def.pad);
  }

  // Chord stabs.
  if (def.stab && def.stab.pattern[two % def.stab.pattern.length] === 'x') {
    for (const n of chord) tone(b, t, n, def.stab.len * sd, def.stab.synth);
  }

  // Arpeggio.
  if (def.arp) {
    const a = def.arp.pattern[two % def.arp.pattern.length];
    if (a >= '0' && a <= '9') {
      const idx = Number(a) % chord.length;
      // Second half of the loop lifts every other note an octave for a little variety.
      const lift = bar >= 8 && s % 6 === 0 ? 12 : 0;
      tone(b, t, chord[idx] + def.arp.octave + lift, sd * 1.5, def.arp.synth);
    }
  }
}

function tick(): void {
  const b = bus;
  if (!b) return;
  const now = b.ctx.currentTime;
  // If the timer was throttled (background tab), skip ahead rather than bursting late notes.
  if (nextTime < now - 0.25) nextTime = now + 0.05;
  while (nextTime < now + LOOKAHEAD) {
    if (pending && step % 16 === 0) {
      current = pending;
      pending = null;
      applyEcho(b, TRACKS[current]);
    }
    const def = TRACKS[current];
    scheduleStep(b, def, step, nextTime);
    nextTime += stepDur(def);
    step = (step + 1) % (16 * LOOP_BARS);
  }
}

function buildBus(ctx: AudioContext, def: TrackDef): Bus {
  const master = ctx.createGain();
  master.gain.value = 0;
  const sweep = ctx.createBiquadFilter();
  sweep.type = 'lowpass';
  sweep.frequency.value = SWEEP_OPEN;
  sweep.Q.value = 1.4;
  const mix = ctx.createGain();
  const send = ctx.createGain();
  const echo = ctx.createDelay(2);
  const fb = ctx.createGain();
  fb.gain.value = def.echoFeedback;
  const echoTone = ctx.createBiquadFilter();
  echoTone.type = 'lowpass';
  echoTone.frequency.value = 2800;
  const wet = ctx.createGain();
  wet.gain.value = def.echoLevel;
  mix.connect(sweep);
  send.connect(echo);
  echo.connect(fb);
  fb.connect(echo);
  echo.connect(echoTone);
  echoTone.connect(wet);
  wet.connect(sweep);
  sweep.connect(master);
  master.connect(ctx.destination);
  const b: Bus = { ctx, master, sweep, mix, send, echo, nodes: [master, sweep, mix, send, echo, fb, echoTone, wet] };
  applyEcho(b, def);
  return b;
}

function teardown(): void {
  if (timer !== null) {
    window.clearInterval(timer);
    timer = null;
  }
  const b = bus;
  bus = null;
  if (!b) return;
  const now = b.ctx.currentTime;
  const g = b.master.gain;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + 0.4);
  window.setTimeout(() => {
    for (const n of b.nodes) n.disconnect();
  }, 700);
}

export const music = {
  /** Start (or switch to) a track on the caller's AudioContext; fades in over 1 s. */
  start(ctx: AudioContext, track: MusicTrack): void {
    if (bus && bus.ctx === ctx) {
      music.setTrack(track);
      return;
    }
    teardown();
    current = track;
    pending = null;
    const def = TRACKS[current];
    const b = buildBus(ctx, def);
    bus = b;
    const now = ctx.currentTime;
    b.master.gain.setValueAtTime(0, now);
    b.master.gain.linearRampToValueAtTime(MASTER_LEVEL, now + 1);
    step = 0;
    nextTime = now + 0.05;
    tick();
    timer = window.setInterval(tick, TICK_MS);
  },
  /** Fade out over ~0.4 s and release all nodes. */
  stop(): void {
    teardown();
  },
  /** Switch track at the next bar line (or just remember it if not playing). */
  setTrack(track: MusicTrack): void {
    if (!bus) {
      current = track;
      pending = null;
      return;
    }
    pending = track === current ? null : track;
  },
  get playing(): boolean {
    return bus !== null;
  },
};
