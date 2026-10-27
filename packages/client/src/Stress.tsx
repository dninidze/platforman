import { useEffect, useRef, useState } from 'react';
import type { GameClient, GameState } from './net';
import { store } from './net';

/** Settings drawer: bot count, busy-server demo, overlay, wallet reset, log download. */
export function SettingsPanel({ s, client, overlay, setOverlay, onClose }: { s: GameState; client: GameClient; overlay: boolean; setOverlay: (v: boolean) => void; onClose: () => void }) {
  const st = s.settings;
  const [bots, setBots] = useState(String(st?.bots ?? 300));
  const [cap, setCap] = useState(String(st?.roomSoftCap ?? 2000));
  useEffect(() => setBots(String(st?.bots ?? 300)), [st?.bots]);
  useEffect(() => setCap(String(st?.roomSoftCap ?? 2000)), [st?.roomSoftCap]);

  const applyBots = (n: number) => {
    const v = Math.max(0, Math.min(9_900, Math.round(n || 0)));
    setBots(String(v));
    store.set('p3.bots', String(v));
    client.updateSettings({ bots: v });
  };
  const download = async () => {
    const jsonl = await client.getLog();
    const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `platform3-rounds-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.jsonl`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="set-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="set-title">Settings</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="setting">
          <label htmlFor="bots">Simulated players (0–9,900)</label>
          <div className="setting-row">
            <input id="bots" type="range" min={0} max={9900} step={100} value={Number(bots) || 0} onChange={(e) => setBots(e.target.value)} onMouseUp={() => applyBots(Number(bots))} onTouchEnd={() => applyBots(Number(bots))} onKeyUp={() => applyBots(Number(bots))} />
            <input className="num" inputMode="numeric" value={bots} onChange={(e) => setBots(e.target.value)} onBlur={() => applyBots(Number(bots))} onKeyDown={(e) => e.key === 'Enter' && applyBots(Number(bots))} aria-label="Simulated players" />
          </div>
          <div className="chips">
            {[0, 300, 2_500, 9_900].map((n) => (
              <button key={n} className="chip" onClick={() => applyBots(n)}>
                {n.toLocaleString()}
              </button>
            ))}
          </div>
        </div>
        <div className="setting">
          <label className="check">
            <input
              type="checkbox"
              checked={!!st?.busyServer}
              onChange={(e) => {
                store.set('p3.busy', e.target.checked ? '1' : '0');
                client.updateSettings({ busyServer: e.target.checked });
              }}
            />
            Simulate busy server (open a new room every <b>{Number(cap).toLocaleString()}</b> players)
          </label>
          <div className="setting-row">
            <label htmlFor="cap" className="muted small">
              roomSoftCap
            </label>
            <input id="cap" className="num" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} onBlur={() => client.updateSettings({ roomSoftCap: Number(cap) || 2000 })} />
          </div>
          <p className="muted small">Rooms now: {s.rooms.map((r) => `${r.roomId} (${r.players.toLocaleString()})`).join(', ')}</p>
        </div>
        <div className="setting">
          <label className="check">
            <input
              type="checkbox"
              checked={overlay}
              onChange={(e) => {
                store.set('p3.overlay', e.target.checked ? '1' : '0');
                setOverlay(e.target.checked);
              }}
            />
            Performance overlay (FPS, tick timing, sync) and stress test
          </label>
        </div>
        <div className="setting setting-row">
          <button className="btn" onClick={() => client.resetBalance()}>
            Reset balance
          </button>
          <button className="btn" onClick={download}>
            Download round log (JSONL)
          </button>
        </div>
        <p className="muted small">Engine: {s.transport}. Everything runs in this page; nothing is sent over the network.</p>
      </div>
    </div>
  );
}

const q = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

export interface StressResult {
  bots: number;
  rounds: number;
  seconds: number;
  fps: { avg: number; min: number; p5: number };
  engineTickLatenessMs: { p50: number; p95: number; max: number; min: number; ticks: number };
  uiDeliveryMs: { p50: number; p95: number; max: number; min: number };
  sync: { ticksChecked: number; checksumMismatches: number };
  engineBusyPct: { avg: number; max: number };
  userAgent: string;
  hardwareConcurrency: number;
  at: string;
}

/** FPS / tick-timing overlay with a stress-test recorder. */
export function StressOverlay({ s, client }: { s: GameState; client: GameClient }) {
  const [fps, setFps] = useState(0);
  const fpsHist = useRef<number[]>([]);
  const rec = useRef<null | { start: number; fps: number[]; delivery: number[]; engine: number[]; engineMin: number[]; enginePerWindow: number[]; busy: number[]; ticks0: number; mism0: number; rounds0: number; targetRounds: number; lastStatsAt: number; engineTicks: number }>(null);
  const [recording, setRecording] = useState(false);
  const [result, setResult] = useState<StressResult | null>(null);
  const [rounds, setRounds] = useState('3');

  useEffect(() => {
    let frames = 0;
    let last = performance.now();
    let raf = 0;
    const loop = (t: number) => {
      frames++;
      if (t - last >= 1000) {
        const v = (frames * 1000) / (t - last);
        setFps(v);
        fpsHist.current.push(v);
        if (fpsHist.current.length > 120) fpsHist.current.shift();
        rec.current?.fps.push(v);
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Feed host stats into the recorder once per stats message.
  const hs = s.hostStats;
  useEffect(() => {
    const r = rec.current;
    if (!r || !hs || hs.at === r.lastStatsAt) return;
    r.lastStatsAt = hs.at;
    if (hs.tickLateness.n) {
      r.engine.push(hs.tickLateness.max, hs.tickLateness.p95);
      r.enginePerWindow.push(hs.tickLateness.p50);
      r.engineMin.push(hs.tickLateness.min);
      r.engineTicks += hs.tickLateness.n;
    }
    r.busy.push(hs.engineBusy * 100);
    const roundsDone = client.metrics.rounds - r.rounds0;
    if (roundsDone >= r.targetRounds) finish();
  });

  const start = () => {
    client.updateSettings({ bots: 9_900 });
    client.metrics.delivery.length = 0;
    rec.current = {
      start: performance.now(),
      fps: [],
      delivery: [],
      engine: [],
      engineMin: [],
      enginePerWindow: [],
      busy: [],
      ticks0: client.metrics.ticks,
      mism0: client.metrics.checksumMismatches,
      rounds0: client.metrics.rounds,
      targetRounds: Math.max(1, Number(rounds) || 3),
      lastStatsAt: 0,
      engineTicks: 0,
    };
    setResult(null);
    setRecording(true);
  };

  const finish = () => {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setRecording(false);
    const delivery = client.metrics.delivery.slice();
    const res: StressResult = {
      bots: s.hostStats?.bots ?? 0,
      rounds: client.metrics.rounds - r.rounds0,
      seconds: (performance.now() - r.start) / 1000,
      fps: { avg: r.fps.reduce((a, b) => a + b, 0) / Math.max(1, r.fps.length), min: Math.min(...r.fps), p5: q(r.fps, 0.05) },
      engineTickLatenessMs: { p50: q(r.enginePerWindow, 0.5), p95: q(r.engine, 0.95), max: Math.max(...r.engine), min: Math.min(...r.engineMin), ticks: r.engineTicks },
      uiDeliveryMs: { p50: q(delivery, 0.5), p95: q(delivery, 0.95), max: Math.max(...delivery), min: Math.min(...delivery) },
      sync: { ticksChecked: client.metrics.ticks - r.ticks0, checksumMismatches: client.metrics.checksumMismatches - r.mism0 },
      engineBusyPct: { avg: r.busy.reduce((a, b) => a + b, 0) / Math.max(1, r.busy.length), max: Math.max(...r.busy) },
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      at: new Date().toISOString(),
    };
    (window as unknown as { __p3stress: StressResult }).__p3stress = res;
    setResult(res);
  };

  const d = client.metrics.delivery.slice(-40);
  const tl = hs?.tickLateness;
  const fmt = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '–');
  const pass = result && result.fps.min >= 50 && result.sync.checksumMismatches === 0 && Math.abs(result.engineTickLatenessMs.max) <= 50 && Math.abs(result.uiDeliveryMs.max) <= 50;
  return (
    <div className="perf" role="status" aria-label="Performance overlay">
      <div>
        <b>{fmt(fps)}</b> FPS <span className="muted">(min 10 s {fmt(Math.min(...fpsHist.current.slice(-10)))})</span>
      </div>
      <div>
        tick fire vs schedule: p95 {fmt(tl?.p95 ?? NaN)} · max {fmt(tl?.max ?? NaN)} ms
      </div>
      <div>
        tick → UI: p95 {fmt(q(d, 0.95))} · max {fmt(Math.max(...d))} ms
      </div>
      <div>
        sync: {client.metrics.ticks} ticks, {client.metrics.checksumMismatches} mismatches
      </div>
      <div>
        engine busy {fmt((hs?.engineBusy ?? 0) * 100)}% · bots {hs?.bots ?? 0} · rooms {hs?.rooms.length ?? 0}
      </div>
      <div className="perf-row">
        {!recording ? (
          <>
            <input className="num" value={rounds} onChange={(e) => setRounds(e.target.value)} aria-label="Rounds to record" />
            <button className="chip" onClick={start}>
              Stress test (9,900 bots)
            </button>
          </>
        ) : (
          <>
            <span>
              recording… {client.metrics.rounds - (rec.current?.rounds0 ?? 0)}/{rec.current?.targetRounds} rounds
            </span>
            <button className="chip" onClick={finish}>
              Stop
            </button>
          </>
        )}
      </div>
      {result && (
        <div className="perf-result">
          <b className={pass ? 'ok' : 'bad'}>{pass ? 'PASS' : 'CHECK'}</b> {result.rounds} rounds, {result.seconds.toFixed(0)} s · FPS avg {fmt(result.fps.avg)} min {fmt(result.fps.min)} · tick fire max {fmt(result.engineTickLatenessMs.max)} ms · UI max {fmt(result.uiDeliveryMs.max)} ms · mismatches {result.sync.checksumMismatches}
          <button className="chip" onClick={() => navigator.clipboard?.writeText(JSON.stringify(result, null, 2))}>
            Copy JSON
          </button>
        </div>
      )}
    </div>
  );
}
