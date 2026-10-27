import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_CURRENCY,
  DemoSessionProvider,
  GAME_TITLE,
  STAGE_REMOVALS,
  chooseSessionProvider,
  formatMoney,
  maskName,
  parseLaunchParams,
  payout,
  stageName,
  type KeyValueStore,
} from '@p3/shared';
import EngineWorker from './engine.worker?worker&inline';
import { FairnessModal } from './Fairness';
import { GameClient, store, type GameState } from './net';
import { SettingsPanel, StressOverlay } from './Stress';
import { InProcessTransport, WebSocketTransport, WorkerTransport, type Transport } from './transport';

const params = new URLSearchParams(location.search);
document.title = GAME_TITLE;

// Identity comes from the launch URL (aggregator token) or a stored demo identity: never a name prompt.
const launch = parseLaunchParams(location.search);
const browserStore: KeyValueStore = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
};
const sessionProvider = chooseSessionProvider(launch, browserStore);
let currency = launch.currency ?? DEFAULT_CURRENCY;
let engineOnMainThread = params.get('engine') === 'main' || typeof Worker === 'undefined';

/**
 * Default: the engine runs in an inlined Web Worker. If the worker cannot start, fall back to running
 * it on the main thread. `?server=ws://host/ws` would talk to a real game server instead.
 */
function makeTransport(): Transport {
  const server = params.get('server');
  if (server) return new WebSocketTransport(server);
  if (!engineOnMainThread) {
    try {
      return new WorkerTransport(
        () => new EngineWorker(),
        () => {
          if (engineOnMainThread) return;
          engineOnMainThread = true;
          client.reconnect();
        },
        { currency },
      );
    } catch {
      engineOnMainThread = true;
    }
  }
  return new InProcessTransport(import('@p3/engine').then((m) => new m.LocalHost({ config: { currency } })));
}

const client = new GameClient(makeTransport);
// For the headless checks: which side of which boundary the engine runs on, and who we are.
(window as unknown as { __p3engine: () => string }).__p3engine = () => client.state.transport;
(window as unknown as { __p3session: () => unknown }).__p3session = () => client.state.session;
void sessionProvider.start(launch).then(
  (session) => {
    currency = session.currency;
    client.start(session);
    // Restore the page's saved settings once the engine is up.
    const bots = store.get('p3.bots');
    const busy = store.get('p3.busy');
    client.updateSettings({ ...(bots !== null ? { bots: Number(bots) } : {}), ...(busy !== null ? { busyServer: busy === '1' } : {}) });
  },
  (e) => client.toast(`Could not start the session: ${String((e as Error)?.message ?? e)}`),
);

/** Settings → "New demo identity": regenerate name and id, then restart the page as that player. */
function newDemoIdentity() {
  if (sessionProvider instanceof DemoSessionProvider) sessionProvider.newIdentity();
  location.reload();
}
// A hot reload re-runs this module; close the old client so it cannot rejoin as the same player.
import.meta.hot?.dispose(() => client.close());

const CURRENCY_SYMBOL: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };

function useGame(): GameState {
  return useSyncExternalStore(client.subscribe, client.getState);
}

/** Re-render on an interval for countdowns. */
function useNow(ms = 100) {
  const [now, setNow] = useState(() => client.serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(client.serverNow()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

export function App() {
  const s = useGame();
  const [fairOpen, setFairOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [overlay, setOverlay] = useState(() => store.get('p3.overlay') === '1' || params.has('perf'));

  if (!s.joined) return <Splash />;
  const sym = CURRENCY_SYMBOL[s.config?.currency ?? ''] ?? '';
  const spectating = s.watching !== null && s.watching !== s.homeRoom;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden>
            ▦
          </span>
          {GAME_TITLE}
        </div>
        <div className="hstats">
          <Stat label={s.session?.mode === 'real' ? 'Player' : 'Player (demo)'} value={s.session?.displayName ?? '–'} />
          <Stat label="Balance" value={`${sym}${formatMoney(s.balance)}`} strong />
          <Stat label="Room" value={s.watching ?? '–'} />
          <Stat label="Round" value={s.round?.roundId.split('#')[1] ?? '–'} />
        </div>
        <button className="pf" onClick={() => setFairOpen(true)} title="Provably fair" aria-label="Provably fair: verify rounds">
          <span aria-hidden>🛡</span> <span className="pf-text">Fair</span>
        </button>
        <button className="pf" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
          <span aria-hidden>⚙</span> <span className="pf-text">Settings</span>
        </button>
      </header>

      {!s.connected && <div className="banner warn">Starting the game engine…</div>}
      {spectating && (
        <div className="banner">
          Spectating {s.watching}.{' '}
          <button className="link" onClick={() => s.homeRoom && client.spectate(s.homeRoom)}>
            Back to my room ({s.homeRoom})
          </button>
        </div>
      )}

      <main className="layout">
        <section className="board-col">
          <MultiplierBar s={s} />
          <Board s={s} spectating={spectating} />
          {!spectating && <BetPanel s={s} sym={sym} />}
        </section>
        <aside className="side">
          <HowToPlay />
          <LiveFeed s={s} sym={sym} />
          <History s={s} />
          <Rooms s={s} />
        </aside>
      </main>

      <div className="toasts" role="status" aria-live="assertive">
        {s.toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
      {fairOpen && <FairnessModal s={s} client={client} onClose={() => setFairOpen(false)} />}
      {settingsOpen && (
        <SettingsPanel
          s={s}
          client={client}
          overlay={overlay}
          setOverlay={setOverlay}
          onNewIdentity={s.session?.provider === 'demo' ? newDemoIdentity : undefined}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {overlay && <StressOverlay s={s} client={client} />}
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`stat ${strong ? 'strong' : ''}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function Splash() {
  return (
    <div className="join">
      <div className="join-card" aria-live="polite">
        <h1>{GAME_TITLE}</h1>
        <p className="muted">Starting the game engine…</p>
      </div>
    </div>
  );
}

function HowToPlay() {
  return (
    <details className="panel help">
      <summary>How to play {GAME_TITLE}</summary>
      <p className="muted small">
        Pick a tile and bet while betting is open. Tiles go Gone one by one and the multiplier climbs after every Gone tile. Cash
        out before your tile goes, or survive all three stages (the board comes back after {stageName(1)} and {stageName(2)}) to
        win 10,000x on the last tile standing. Play money only.
      </p>
    </details>
  );
}

function MultiplierBar({ s }: { s: GameState }) {
  const now = useNow();
  const r = s.round;
  if (!r) return <div className="mbar" />;
  const resurrected = r.phase === 'intermission';
  const stageLen = STAGE_REMOVALS[resurrected ? r.stage : r.stage - 1];
  const removed = resurrected ? 0 : r.removed;
  const left = 100 - removed;
  const stageOver = !resurrected && removed >= stageLen;
  const survive = !stageOver && r.phase !== 'ended' ? (left - 1) / left : null;
  const inPlay = s.you?.roundId === r.roundId && (s.you.state === 'alive' || s.you.state === 'betting');
  const secs = r.phaseEndsAt ? Math.max(0, (r.phaseEndsAt - now) / 1000) : null;
  const phaseLabel =
    r.phase === 'betting'
      ? `Betting closes in ${secs?.toFixed(1)}s`
      : r.phase === 'intermission'
        ? `Resurrection – ${stageName(r.stage + 1)} in ${secs?.toFixed(1)}s`
        : r.phase === 'ended'
          ? `Next round in ${secs?.toFixed(1)}s`
          : r.fast
            ? 'No players left – finishing fast'
            : r.removed === 0 && r.stage === 1
              ? 'First tile about to go'
              : 'Tiles going…';
  return (
    <div className={`mbar phase-${r.phase}`}>
      <div className="stages" aria-label={`${stageName(r.stage)} of 3`}>
        {[1, 2, 3].map((n) => (
          <span key={n} className={`stage-pill ${n === r.stage ? 'on' : n < r.stage ? 'done' : ''}`}>
            {stageName(n)}
          </span>
        ))}
      </div>
      <div className="mrow">
        <div className="mult" aria-live="polite" aria-atomic="true">
          {r.multiplier.toFixed(2)}x
        </div>
        <div className="mside">
          <div>
            Next: <b>{r.nextMultiplier !== null ? `${r.nextMultiplier.toFixed(2)}x` : '–'}</b>
          </div>
          <div>
            Tiles left: <b>{left}</b> <span className="muted">({removed}/{stageLen} gone)</span>
          </div>
          <div>
            {inPlay ? 'Your tile' : 'A tile'} survives next: <b>{survive !== null ? `${(survive * 100).toFixed(1)}%` : '–'}</b>
          </div>
        </div>
      </div>
      <div className="phase-label">{phaseLabel}</div>
    </div>
  );
}

function Board({ s, spectating }: { s: GameState; spectating: boolean }) {
  const r = s.round;
  const [selected, setSelected] = useState<number | null>(null);
  const you = s.you && r && s.you.roundId === r.roundId ? s.you : null;
  const myTile = you && (you.state === 'alive' || you.state === 'betting') ? you.tileId : null;
  const cap = s.config?.tileCapacity ?? 99;
  const lostFlash = s.lostAt !== null && Date.now() - s.lostAt < 1600;
  useEffect(() => {
    if (r?.phase === 'betting' && !you) return;
    setSelected(null);
  }, [r?.roundId, r?.phase, you?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!r) return <div className="board" />;
  const canMove = !spectating && myTile !== null && (r.phase === 'betting' || r.phase === 'running' || r.phase === 'intermission');
  const canPick = !spectating && r.phase === 'betting' && (!you || you.state === 'idle');

  const onTile = (t: number) => {
    if (r.gone[t]) return;
    if (canMove && t !== myTile) client.move(t);
    else if (canPick) {
      setSelected(t);
      window.dispatchEvent(new CustomEvent('p3-select', { detail: t }));
    }
  };

  return (
    <div
      className={`board ${r.fast ? 'fast' : ''} ${r.phase === 'intermission' ? 'resurrect' : ''} ${lostFlash ? 'lost-shake' : ''}`}
      role="grid"
      aria-label="10 by 10 tile grid"
    >
      {r.counts.map((count, t) => {
        const gone = r.gone[t];
        const full = !gone && count >= cap;
        const mine = t === myTile;
        const justGone = gone && s.lastGone?.tile === t;
        const label = gone ? 'Gone' : full ? 'Full' : String(count);
        const cls = ['tile', gone ? 'gone' : 'alive', full ? 'full' : '', mine ? 'mine' : '', selected === t ? 'selected' : '', justGone ? 'just-gone' : ''].join(' ');
        return (
          <button
            key={`${r.stage}-${t}`}
            className={cls}
            onClick={() => onTile(t)}
            disabled={gone}
            aria-label={`Tile ${t + 1}: ${gone ? 'Gone' : full ? 'Full' : `${count} players`}${mine ? ', your tile' : ''}`}
          >
            {mine && <span className="you-badge">YOU</span>}
            <span className="tile-count">{label}</span>
          </button>
        );
      })}
      {r.phase === 'intermission' && (
        <div className="overlay">
          <div className="overlay-title">Resurrection</div>
          <div>All tiles are back. {stageName(r.stage + 1)} starts soon.</div>
          <Countdown at={r.phaseEndsAt} />
        </div>
      )}
      {r.phase === 'ended' && <RoundOverOverlay s={s} />}
      {lostFlash && <div className="lost-banner">Your tile is Gone</div>}
    </div>
  );
}

function Countdown({ at }: { at: number | null }) {
  const now = useNow();
  if (!at) return null;
  return <div className="countdown">{Math.max(0, (at - now) / 1000).toFixed(1)}s</div>;
}

function RoundOverOverlay({ s }: { s: GameState }) {
  const last = s.revealed[0];
  const r = s.round!;
  const you = s.you?.roundId === r.roundId ? s.you : null;
  const sym = CURRENCY_SYMBOL[s.config?.currency ?? ''] ?? '';
  return (
    <div className="overlay ended">
      <div className="overlay-title">Round over</div>
      {last && last.roundId === r.roundId && (
        <div>
          {last.emptiedAtStage ? `No survivors at ${stageName(last.emptiedAtStage)}.` : `${last.survivorsPaid.length} survivor(s) paid 10,000x!`} 10,000x tile was #
          {last.jackpotTile + 1}.
        </div>
      )}
      {you && you.state === 'cashedOut' && (
        <div className="win">
          You won {sym}
          {formatMoney(you.payout)} at {you.multiplier?.toFixed(2)}x
        </div>
      )}
      {you && you.state === 'lost' && <div className="loss">Your tile went Gone.</div>}
      <Countdown at={r.phaseEndsAt} />
    </div>
  );
}

function BetPanel({ s, sym }: { s: GameState; sym: string }) {
  const r = s.round;
  const cfg = s.config!;
  const [amount, setAmount] = useState('1.00');
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    const on = (e: Event) => setSelected((e as CustomEvent<number>).detail);
    window.addEventListener('p3-select', on);
    return () => window.removeEventListener('p3-select', on);
  }, []);
  useEffect(() => setSelected(null), [r?.roundId]);

  const you = s.you && r && s.you.roundId === r.roundId ? s.you : null;
  const minor = Math.round(Number(amount) * 100);
  const clamp = (v: number) => Math.min(cfg.maxBet, Math.max(cfg.minBet, Math.round(v)));
  const setMinor = (v: number) => setAmount((clamp(v) / 100).toFixed(2));
  const potential = useMemo(() => {
    if (!you || !r || you.state !== 'alive') return 0;
    return payout(you.bet, Math.round(r.multiplier * 100), cfg.maxWinPerBet);
  }, [you, r, cfg.maxWinPerBet]);

  if (!r) return null;
  const inPlay = you && (you.state === 'alive' || you.state === 'betting');
  const cashoutOpen = r.phase === 'intermission' || (r.phase === 'running' && !(r.stage === 1 && r.removed === 0));

  if (r.phase === 'betting' && !inPlay) {
    const valid = Number.isFinite(minor) && minor >= cfg.minBet && minor <= cfg.maxBet;
    return (
      <div className="betpanel">
        <div className="amount-row">
          <label htmlFor="amt">Bet {sym}</label>
          <input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => valid || setMinor(minor || cfg.minBet)} />
          <button className="chip" onClick={() => setMinor(minor / 2)}>
            ½
          </button>
          <button className="chip" onClick={() => setMinor(minor * 2)}>
            ×2
          </button>
          <button className="chip" onClick={() => setMinor(cfg.minBet)}>
            Min
          </button>
          <button className="chip" onClick={() => setMinor(cfg.maxBet)}>
            Max
          </button>
        </div>
        <button className="btn primary big" disabled={selected === null || !valid} onClick={() => selected !== null && client.bet(minor, selected)}>
          {selected === null ? 'Tap a tile to choose it' : `Bet ${sym}${formatMoney(minor)} on tile #${selected + 1}`}
        </button>
      </div>
    );
  }
  if (r.phase === 'betting' && you?.state === 'betting') {
    return (
      <div className="betpanel">
        <div className="bet-info">
          Bet {sym}
          {formatMoney(you.bet)} on tile #{(you.tileId ?? 0) + 1}. Tap another tile to move.
        </div>
        <button className="btn" onClick={() => client.cancelBet()}>
          Cancel bet
        </button>
      </div>
    );
  }
  if (you?.state === 'alive') {
    return (
      <div className="betpanel">
        <button className="btn cashout big" disabled={!cashoutOpen} onClick={() => client.cashout()}>
          {cashoutOpen ? `Cash out ${sym}${formatMoney(potential)}` : 'Cash out opens after the first tile goes'}
        </button>
        <div className="bet-info muted">
          Bet {sym}
          {formatMoney(you.bet)} · tile #{(you.tileId ?? 0) + 1} · tap a tile to move
        </div>
      </div>
    );
  }
  return (
    <div className="betpanel">
      <div className="bet-info muted" aria-live="polite">
        {you?.state === 'cashedOut'
          ? `${you.maxWin ? 'Max win reached: ' : 'Cashed out: '}${sym}${formatMoney(you.payout)} at ${you.multiplier?.toFixed(2)}x`
          : you?.state === 'lost'
            ? 'Your tile went Gone. Bet again next round.'
            : 'Round in progress. Watch now, bet in the next round.'}
      </div>
    </div>
  );
}

function LiveFeed({ s, sym }: { s: GameState; sym: string }) {
  const f = s.feed;
  const you = s.you && s.feed && s.you.roundId === s.feed.roundId && s.you.state === 'cashedOut' ? s.you : null;
  const youRow = you && s.session
    ? (f?.topCashouts ?? []).findIndex((c) => c.nickname === maskName(s.session!.displayName) && c.amount === you.payout && c.multiplier === you.multiplier)
    : -1;
  return (
    <div className="panel">
      <h2>Live</h2>
      <div className="totals">
        <div>
          <b>{f?.totals.players ?? 0}</b>
          <span>players</span>
        </div>
        <div>
          <b>{f?.totals.alive ?? 0}</b>
          <span>alive</span>
        </div>
        <div>
          <b>{f?.totals.cashedOut ?? 0}</b>
          <span>cashed out</span>
        </div>
        <div>
          <b>{f?.totals.lost ?? 0}</b>
          <span>lost</span>
        </div>
      </div>
      <ol className="feed">
        {(f?.topCashouts ?? []).slice(0, 8).map((c, i) => (
          <li key={i} className={i === youRow ? 'you' : undefined}>
            <span className="nick">{i === youRow ? `You (${c.nickname})` : c.nickname}</span>
            <span>{c.multiplier.toFixed(2)}x</span>
            <span className="amt">
              {sym}
              {formatMoney(c.amount)}
            </span>
          </li>
        ))}
        {(!f || f.topCashouts.length === 0) && <li className="muted">No cashouts yet</li>}
      </ol>
    </div>
  );
}

function History({ s }: { s: GameState }) {
  return (
    <div className="panel">
      <h2>Recent rounds</h2>
      <ul className="history">
        {s.history.slice(0, 10).map((h) => (
          <li key={h.roundId}>
            <span className="muted">#{h.roundId.split('#')[1]}</span>
            <span>10,000x tile #{h.jackpotTile + 1}</span>
            <span className={h.emptiedAtStage ? 'muted' : 'win'}>
              {h.emptiedAtStage ? `no survivors at ${stageName(h.emptiedAtStage)}` : `${h.survivors} won 10,000x`}
            </span>
          </li>
        ))}
        {s.history.length === 0 && <li className="muted">No rounds yet</li>}
      </ul>
    </div>
  );
}

function Rooms({ s }: { s: GameState }) {
  return (
    <div className="panel">
      <h2>Rooms</h2>
      <ul className="rooms">
        {s.rooms.map((r) => (
          <li key={r.roomId}>
            <span>
              {r.roomId} {r.roomId === s.homeRoom && <em>(yours)</em>}
            </span>
            <span className="muted">{r.players} players</span>
            {r.roomId !== s.watching && (
              <button className="link" onClick={() => client.spectate(r.roomId)}>
                {r.roomId === s.homeRoom ? 'Return' : 'Spectate'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
