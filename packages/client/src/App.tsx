import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  DEFAULT_CONFIG,
  DEFAULT_CURRENCY,
  MULTIPLIERS_100,
  DemoSessionProvider,
  GAME_TITLE,
  STAGE_REMOVALS,
  chooseSessionProvider,
  formatMoney,
  maskName,
  parseLaunchParams,
  payout,
  formatMultiplier,
  stageName,
  tileBand,
  tileCapsFor,
  type TileCaps,
  type KeyValueStore,
  type RoundHighlights,
} from '@p3/shared';
import EngineWorker from './engine.worker?worker&inline';
import { FairnessModal } from './Fairness';
import { GameClient, store, type GameState } from './net';
import { SettingsPanel, StressOverlay } from './Stress';
import { TopResults, type TopSort, type TopWindow } from './topResults';
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
    if (bots !== null) client.updateSettings({ bots: Number(bots) });
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

/** Top results for 24h / Week / Month / Year, kept on this device (CHANGES_6 §10). */
const topResults = new TopResults(
  (() => {
    try {
      return localStorage;
    } catch {
      return null;
    }
  })(),
);
/** Top entries recorded by this page (only those can open round details). */
const sessionTopKeys = new Set<string>();

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

/** The player's tile choice before betting (CHANGES_4 §2): picked at random by the game, or by a tap. */
interface Pick {
  tile: number;
  random: boolean;
}

const randomTile = () => {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return b[0] % 100;
};

export function App() {
  const s = useGame();
  const [fairOpen, setFairOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [overlay, setOverlay] = useState(() => store.get('p3.overlay') === '1' || params.has('perf'));
  const [pick, setPick] = useState<Pick | null>(null);
  const [amount, setAmount] = useState('1.00');
  /** A bet queued with "Place bet on random tile for next round" (amount in minor units). */
  const [queued, setQueued] = useState<number | null>(null);
  /** CHANGES_5 §2: bumps when a tile is tapped while not in the game; the bet section pulses yellow. */
  const [nudge, setNudge] = useState(0);
  /** Round opened from "Recent rounds" (round details + verification). */
  const [detailsFor, setDetailsFor] = useState<string | null>(null);

  const r = s.round;
  const phase = r?.phase;
  const roundId = r?.roundId;
  // Record each finished round's highlights for the Top views.
  const lastEnded = s.revealed[0]?.roundId;
  useEffect(() => {
    const h = lastEnded ? s.history.find((x) => x.roundId === lastEnded) : undefined;
    if (!h) return;
    const t = Date.now();
    topResults.add({ id: h.roundId, t, reached: h.emptiedAtStage ?? 3, highlights: h.highlights }, t);
    sessionTopKeys.add(`${h.roundId}@${t}`);
  }, [lastEnded]); // eslint-disable-line react-hooks/exhaustive-deps
  // When betting opens: pick a random tile, and place a queued bet on it.
  useEffect(() => {
    if (phase !== 'betting' || !roundId) return;
    const tile = randomTile();
    setPick({ tile, random: true });
    if (queued !== null) {
      client.bet(queued, tile);
      setQueued(null);
    }
  }, [phase, roundId]); // eslint-disable-line react-hooks/exhaustive-deps

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

      <main className="layout">
        <section className="center-col" aria-label="Game">
          <Board s={s} spectating={spectating} pick={pick} setPick={setPick} onNudge={() => setNudge((n) => n + 1)} />
          <div className="under">
            <MultiplierSection s={s} pick={pick} queued={queued} />
            {!spectating && <BetSection s={s} pick={pick} amount={amount} setAmount={setAmount} queued={queued} setQueued={setQueued} nudge={nudge} />}
          </div>
        </section>
        <aside className="left-col" aria-label="Live bets">
          <LiveBets s={s} sym={sym} />
        </aside>
        <aside className="right-col" aria-label="Past games">
          <RoundsPanel s={s} sym={sym} top={topResults} onOpen={setDetailsFor} />
          <HowToPlay />
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
      {detailsFor && <FairnessModal s={s} client={client} roundId={detailsFor} onClose={() => setDetailsFor(null)} />}
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
        While betting is open the game picks a random tile for you; tap another tile to choose your own, then bet. Tiles go one by
        one and the multiplier climbs after every one. Cash out before your tile goes, or survive all three stages ({stageName(1)},{' '}
        {stageName(2)}, {stageName(3)}; the board comes back between them) to win {formatMultiplier(TOP_MULTIPLIER)} on the last tile
        standing. When the round starts, a tile with {DEFAULT_CONFIG.tileCapPct}% of the bets on it is locked (red). Empty tiles are
        green, occupied tiles yellow. Play money only.
      </p>
    </details>
  );
}

const METAL = ['bronze', 'silver', 'gold'] as const;
/** The last multiplier of the last stage (10,778x with the CHANGES_6 table). */
const TOP_MULTIPLIER = MULTIPLIERS_100[2][MULTIPLIERS_100[2].length - 1] / 100;

/** Thresholds for colouring: live from the bets on the board while betting, frozen once the round runs. */
function useCaps(s: GameState): TileCaps | null {
  const r = s.round;
  if (!r) return null;
  if (r.phase === 'betting' && s.config) {
    const bets = r.counts.reduce((a, b) => a + b, 0);
    return tileCapsFor(bets, s.config.tileCapPct, s.config.tileYellowPct, true);
  }
  return r.caps;
}

/** Message line 2 (CHANGES_6 §6): general game commentary. */
function gameLine(s: GameState, now: number): { text: string; kind: string } {
  const r = s.round!;
  const secs = r.phaseEndsAt ? Math.max(0, (r.phaseEndsAt - now) / 1000).toFixed(1) : null;
  if (r.phase === 'betting') return { text: `Betting closes in ${secs} s`, kind: 'info' };
  if (r.phase === 'intermission') {
    if (r.fast) return { text: `${stageName(r.stage + 1)} next`, kind: 'info' };
    const tiles = r.survived?.filter(Boolean).length ?? 0;
    const players = r.counts.reduce((a, b) => a + b, 0);
    return { text: `Resurrection! ${tiles} tiles survived with ${players} player${players === 1 ? '' : 's'}. ${stageName(r.stage + 1)} in ${secs} s`, kind: 'resurrect' };
  }
  if (r.phase === 'ended') {
    const last = s.revealed[0]?.roundId === r.roundId ? s.revealed[0] : null;
    const result = last
      ? last.survivorsPaid.length
        ? `${last.survivorsPaid.length} won ${formatMultiplier(TOP_MULTIPLIER)} on tile #${last.jackpotTile + 1}!`
        : `Last tile standing: #${last.jackpotTile + 1}.`
      : '';
    return { text: `Round over. ${result} Next round in ${secs} s`, kind: 'info' };
  }
  if (r.fast) return { text: 'Everyone is out: playing to the last tile', kind: 'info' };
  if (r.removed === 0 && r.stage === 1) return { text: 'Round started. First tile about to go', kind: 'info' };
  return { text: `${stageName(r.stage)}: tiles going`, kind: 'info' };
}

/** Message line 1 (CHANGES_6 §6): what this player can do or just did. */
function playerLine(s: GameState, now: number, pick: Pick | null, queued: number | null): { text: string; kind: string } {
  const r = s.round!;
  const cur = s.config?.currency ?? '';
  const you = s.you?.roundId === r.roundId ? s.you : null;
  if (you?.state === 'betting') return { text: `You're on tile #${(you.tileId ?? 0) + 1}. Tap a tile to move`, kind: 'me' };
  if (you?.state === 'alive') {
    if (r.phase === 'intermission') return { text: `You survived ${stageName(r.stage)}! Move or cash out`, kind: 'win' };
    return { text: `You're on tile #${(you.tileId ?? 0) + 1}`, kind: 'me' };
  }
  if (you?.state === 'cashedOut') return { text: `Cashed out ${formatMultiplier(you.multiplier ?? 0)} · ${formatMoney(you.payout)} ${cur}`, kind: 'win' };
  if (you?.state === 'lost' && (r.phase !== 'ended' || (s.lostAt !== null && now - (s.lostAt + s.offset) < 5000))) return { text: 'Your tile is gone', kind: 'loss' };
  if (queued !== null) return { text: 'Your bet goes on a random tile next round', kind: 'me' };
  if (r.phase === 'betting' && pick) {
    return pick.random ? { text: `Random tile #${pick.tile + 1} · tap a tile to choose`, kind: 'hint' } : { text: `Tile #${pick.tile + 1} selected`, kind: 'hint' };
  }
  return { text: 'Bet now for the next round', kind: 'hint' };
}

/**
 * Under the grid, left (fixed size): stage tabs 10x / 100x / 10kx, the multiplier, the two-line message box
 * (thin grey frame) and "Tiles left: X of Y". Bronze / silver / gold frame by stage.
 */
function MultiplierSection({ s, pick, queued }: { s: GameState; pick: Pick | null; queued: number | null }) {
  const now = useNow();
  const r = s.round;
  if (!r) return <div className="mbox" />;
  const resurrected = r.phase === 'intermission';
  const shownStage = resurrected ? Math.min(3, r.stage + 1) : r.stage;
  const stageLen = STAGE_REMOVALS[shownStage - 1];
  const removed = resurrected ? 0 : r.removed;
  const top = playerLine(s, now, pick, queued);
  const game = gameLine(s, now);
  return (
    <div className={`mbox metal-${METAL[shownStage - 1]} phase-${r.phase}`}>
      <div className="stages" role="tablist" aria-label={`Stage ${stageName(shownStage)}`}>
        {[1, 2, 3].map((n) => (
          <span key={n} role="tab" aria-selected={n === shownStage} className={`stage-pill metal-${METAL[n - 1]} ${n === shownStage ? 'on' : n < shownStage ? 'done' : ''}`}>
            {stageName(n)}
          </span>
        ))}
      </div>
      <div className="mult" aria-live="polite" aria-atomic="true">
        {formatMultiplier(r.multiplier)}
      </div>
      <div className="msgbox" role="status" aria-live="polite">
        <div className={`msg-line msg-${top.kind}`} title={top.text}>
          {top.text}
        </div>
        <div className={`msg-line msg-${game.kind}`} title={game.text}>
          {game.text}
        </div>
      </div>
      <div className="mtiles">
        Tiles left: <b>{stageLen - removed}</b> of {stageLen}
      </div>
    </div>
  );
}

function Board({
  s,
  spectating,
  pick,
  setPick,
  onNudge,
}: {
  s: GameState;
  spectating: boolean;
  pick: Pick | null;
  setPick: (p: Pick) => void;
  onNudge: () => void;
}) {
  const r = s.round;
  const caps = useCaps(s);
  const you = s.you && r && s.you.roundId === r.roundId ? s.you : null;
  const myTile = you && (you.state === 'alive' || you.state === 'betting') ? you.tileId : null;
  if (!r || !caps) return <div className="board" />;
  const canMove = !spectating && myTile !== null && (r.phase === 'betting' || r.phase === 'running' || r.phase === 'intermission');
  const canPick = !spectating && r.phase === 'betting' && (!you || you.state === 'idle');
  const pickedTile = canPick ? pick?.tile : null;
  // Your bet's frame: bronze while betting and in 10x, then silver, then gold.
  const metal = METAL[(r.phase === 'intermission' ? Math.min(3, r.stage + 1) : r.stage) - 1];
  // CHANGES_6 §5: the last tile standing of the final stage is the winning tile.
  const winner = r.stage === 3 && r.removed >= STAGE_REMOVALS[2] && r.phase !== 'intermission' ? r.gone.findIndex((g) => !g) : -1;

  const onTile = (t: number) => {
    // Not in the game (no bet, cashed out or lost): point at the bet section.
    if (!spectating && myTile === null && !canPick) return onNudge();
    if (r.gone[t]) return;
    if (canMove && t !== myTile) client.move(t);
    else if (canPick) setPick({ tile: t, random: false });
  };

  return (
    <div className={`board ${r.fast ? 'fast' : ''} ${r.phase === 'intermission' ? 'resurrect' : ''}`} role="grid" aria-label="10 by 10 tile grid">
      {r.counts.map((count, t) => {
        const gone = r.gone[t];
        const band = tileBand(count, gone, caps);
        const mine = t === myTile;
        const justGone = gone && s.lastGone?.tile === t;
        const survived = r.phase === 'intermission' && r.survived?.[t] && count > 0;
        const cls = [
          'tile',
          `band-${band}`,
          mine ? `mine metal-${metal}` : '',
          pickedTile === t ? 'picked' : '',
          justGone ? 'just-gone' : '',
          survived ? 'survived' : '',
          t === winner ? 'winner' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={`${r.stage}-${t}`}
            className={cls}
            onClick={() => onTile(t)}
            aria-disabled={gone}
            aria-label={`Tile ${t + 1}: ${gone ? 'gone' : band === 'full' ? `locked, ${count} players` : `${count} players`}${mine ? ', me' : pickedTile === t ? ', selected' : ''}${
              t === winner ? ', last tile standing' : ''
            }`}
          >
            {mine && <span className="you-badge">ME</span>}
            <span className="tile-count">{gone ? '×' : count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Press-and-hold repeat for the − / + buttons. */
function useHoldRepeat(fn: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const start = () => {
    stop();
    fn();
    const loop = (delay: number) => {
      timer.current = setTimeout(() => {
        fn();
        loop(Math.max(40, delay * 0.8));
      }, delay);
    };
    loop(400);
  };
  return { onPointerDown: start, onPointerUp: stop, onPointerLeave: stop, onPointerCancel: stop };
}

/** Under the grid, right (fixed size): the main button (CHANGES_6 §6) and the amount row (§7). */
function BetSection({
  s,
  pick,
  amount,
  setAmount,
  queued,
  setQueued,
  nudge,
}: {
  s: GameState;
  pick: Pick | null;
  amount: string;
  setAmount: (v: string) => void;
  queued: number | null;
  setQueued: (v: number | null) => void;
  nudge: number;
}) {
  const r = s.round;
  const cfg = s.config!;
  const cur = cfg.currency;
  const you = s.you && r && s.you.roundId === r.roundId ? s.you : null;
  const minor = Math.round(Number(amount) * 100);
  const valid = Number.isFinite(minor) && minor >= cfg.minBet && minor <= cfg.maxBet;
  const clamp = (v: number) => Math.min(cfg.maxBet, Math.max(cfg.minBet, Math.round(v)));
  const setMinor = (v: number) => setAmount((clamp(v) / 100).toFixed(2));
  // − / + step by 0.10; read the latest amount through a ref while the button is held.
  const minorRef = useRef(minor);
  minorRef.current = Number.isFinite(minor) ? minor : cfg.minBet;
  const step = (d: number) => {
    const next = clamp(Math.round(minorRef.current / 10) * 10 + d);
    minorRef.current = next;
    setAmount((next / 100).toFixed(2));
  };
  const minus = useHoldRepeat(() => step(-10));
  const plus = useHoldRepeat(() => step(10));
  const potential = useMemo(() => {
    if (!you || !r || you.state !== 'alive') return 0;
    return payout(you.bet, Math.round(r.multiplier * 100), cfg.maxWinPerBet);
  }, [you, r, cfg.maxWinPerBet]);
  if (!r) return <div className="betbox" />;

  let main: { text: string; color: 'green' | 'yellow' | 'red'; onClick: () => void; disabled?: boolean };
  if (r.phase === 'betting' && you?.state === 'betting') {
    main = { text: `Cancel bet ${formatMoney(you.bet)} ${cur}`, color: 'red', onClick: () => client.cancelBet() };
  } else if (r.phase === 'betting') {
    main = { text: `Bet ${formatMoney(valid ? minor : 0)} ${cur}`, color: 'green', disabled: !pick || !valid, onClick: () => pick && client.bet(minor, pick.tile) };
  } else if (you?.state === 'alive') {
    const open = r.phase === 'intermission' || (r.phase === 'running' && !(r.stage === 1 && r.removed === 0));
    main = { text: `Cash bet ${formatMoney(potential)} ${cur}`, color: 'yellow', disabled: !open, onClick: () => client.cashout() };
  } else if (queued !== null) {
    main = { text: `Cancel bet ${formatMoney(queued)} ${cur}`, color: 'red', onClick: () => setQueued(null) };
  } else {
    main = { text: `Bet ${formatMoney(valid ? minor : 0)} ${cur}`, color: 'green', disabled: !valid, onClick: () => setQueued(minor) };
  }

  return (
    <div className={`betbox ${nudge ? `nudge-${nudge % 2}` : ''}`}>
      <button className={`mainbtn mb-${main.color}`} disabled={main.disabled} onClick={main.onClick}>
        <span className="cta">{main.text}</span>
      </button>
      <div className="amount-row">
        <div className="amount-group">
          <button className="step" aria-label="Decrease bet by 0.10" {...minus}>
            −
          </button>
          <input className="amount" inputMode="decimal" aria-label={`Bet amount in ${cur}`} value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => valid || setMinor(minor || cfg.minBet)} />
          <button className="step" aria-label="Increase bet by 0.10" {...plus}>
            +
          </button>
        </div>
        {[1, 2, 5, 10].map((v) => (
          <button key={v} className="chip quick" onClick={() => setMinor(v * 100)} aria-label={`Bet ${v}.00 ${cur}`}>
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Left column (CHANGES_6 §9): Aviator-style live bets. */
function LiveBets({ s, sym }: { s: GameState; sym: string }) {
  const f = s.feed && s.round && s.feed.roundId === s.round.roundId ? s.feed : null;
  const r = s.round;
  const you = s.you && r && s.you.roundId === r.roundId && s.you.state !== 'idle' ? s.you : null;
  const myMask = s.session ? maskName(s.session.displayName) : '';
  let skipped = false;
  const others = (f?.bets ?? []).filter((b) => {
    if (!skipped && you && b.nickname === myMask && b.bet === you.bet && b.tile === you.tileId) {
      skipped = true;
      return false;
    }
    return true;
  });
  const money = (v: number) => `${sym}${formatMoney(v)}`;
  const row = (key: string | number, name: string, b: { bet: number; tile: number | null; state: string; multiplier: number | null; payout: number }, me = false) => (
    <tr key={key} className={`st-${b.state}${me ? ' me' : ''}`}>
      <td className="nick">{name}</td>
      <td>{money(b.bet)}</td>
      <td className={b.state === 'cashedOut' ? 'win' : b.state === 'lost' ? 'loss' : 'muted'}>{b.tile !== null ? `#${b.tile + 1}` : ''}</td>
      <td className="win">{b.state === 'cashedOut' && b.multiplier !== null ? formatMultiplier(b.multiplier) : ''}</td>
      <td className="win">{b.state === 'cashedOut' ? money(b.payout) : ''}</td>
    </tr>
  );
  return (
    <div className="panel livebets">
      <div className="lb-head">
        <div>
          <div className="lb-label">Bets</div>
          <div className="lb-big">
            {(f?.totals.alive ?? 0).toLocaleString()} <span className="muted">/ {(f?.totals.players ?? 0).toLocaleString()}</span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="lb-label">Total cashout</div>
          <div className="lb-big win">{money(f?.stats.paid ?? 0)}</div>
        </div>
      </div>
      <table className="lbtable">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Bet</th>
            <th scope="col">Tile</th>
            <th scope="col">x</th>
            <th scope="col">Win</th>
          </tr>
        </thead>
        <tbody>
          {you && row('me', 'Me', { bet: you.bet, tile: you.tileId, state: you.state, multiplier: you.multiplier, payout: you.payout }, true)}
          {others.map((b, i) => row(i, b.nickname, b))}
          {f && f.moreBets > 0 && (
            <tr>
              <td colSpan={5} className="muted more">
                + {f.moreBets.toLocaleString()} more
              </td>
            </tr>
          )}
          {(!f || f.bets.length === 0) && !you && (
            <tr>
              <td colSpan={5} className="muted">
                No bets yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

type RoundsTab = 'recent' | TopWindow;
const TABS: [RoundsTab, string][] = [
  ['recent', 'Recent'],
  ['24h', '24h'],
  ['week', 'Week'],
  ['month', 'Month'],
  ['year', 'Year'],
];

/** Right column (CHANGES_6 §10): Recent rounds, or the Top results over a rolling window. */
function RoundsPanel({ s, sym, top, onOpen }: { s: GameState; sym: string; top: TopResults; onOpen: (roundId: string) => void }) {
  const [tab, setTab] = useState<RoundsTab>('recent');
  const [sort, setSort] = useState<TopSort>('man');
  useNow(60_000); // re-evaluate rolling windows every minute
  const inSession = new Set(s.history.map((h) => h.roundId));
  const linked = (key: string, id: string) => inSession.has(id) && (tab === 'recent' || sessionTopKeys.has(key));
  const rows: { key: string; id: string; reached: number; highlights: RoundHighlights | undefined }[] =
    tab === 'recent'
      ? s.history.slice(0, 15).map((h) => ({ key: h.roundId, id: h.roundId, reached: h.emptiedAtStage ?? 3, highlights: h.highlights }))
      : top.query(tab, sort).map((e) => ({ key: `${e.id}@${e.t}`, id: e.id, reached: e.reached, highlights: e.highlights }));
  const isTop = tab !== 'recent';
  const sortBtn = (k: TopSort, label: string) => (
    <button className={`sortbtn ${sort === k ? 'on' : ''}`} aria-pressed={sort === k} onClick={() => setSort(k)}>
      {label}
    </button>
  );
  return (
    <div className="panel rounds-panel">
      <div className="rp-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`rp-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <div className="rp-max">
        Round max <b className="gold">{formatMultiplier(TOP_MULTIPLIER)}</b>
      </div>
      <table className="rounds">
        <thead>
          <tr>
            <th scope="col">Round</th>
            <th scope="col">Top man {isTop && sortBtn('man', 'x')}</th>
            <th scope="col">
              Top cashout {isTop && sortBtn('cashX', 'x')}
              {isTop && sortBtn('cashWin', 'Win')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => {
            const tm = h.highlights?.topMan;
            const tc = h.highlights?.topCashout;
            const short = `#${h.id.split('#')[1] ?? h.id}`;
            return (
              <tr key={h.key}>
                <td>
                  {linked(h.key, h.id) ? (
                    <button className="link" onClick={() => onOpen(h.id)} title={`${h.id}: details and verification`}>
                      {short}
                    </button>
                  ) : (
                    <span>{short}</span>
                  )}
                  <div className="sub">Reached {stageName(h.reached)}</div>
                </td>
                <td>
                  {tm ? (
                    <>
                      <b className="mult-cell">{formatMultiplier(tm.multiplier)}</b>
                      <div className="sub">{tm.survived} tiles</div>
                    </>
                  ) : (
                    '–'
                  )}
                </td>
                <td>
                  {tc ? (
                    <>
                      <b className="mult-cell win">{formatMultiplier(tc.multiplier)}</b>
                      <div className="sub">
                        {sym}
                        {formatMoney(tc.amount)}
                      </div>
                    </>
                  ) : (
                    '–'
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                {isTop ? 'No rounds in this period on this device yet' : 'No rounds yet'}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
