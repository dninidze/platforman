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
  type PublicBet,
} from '@p3/shared';
import EngineWorker from './engine.worker?worker&inline';
import { FairnessModal } from './Fairness';
import { GameClient, store, type GameState } from './net';
import { SettingsPanel, StressOverlay } from './Stress';
import { AMOUNT_RE, formatAmount, stepBet } from './betSteps';
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
(window as unknown as { __p3round: () => string }).__p3round = () => client.state.round?.roundId ?? '';
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
function useNow(ms = 100, active = true) {
  const [now, setNow] = useState(() => client.serverNow());
  useEffect(() => {
    if (!active) return;
    setNow(client.serverNow());
    const id = setInterval(() => setNow(client.serverNow()), ms);
    return () => clearInterval(id);
  }, [ms, active]);
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
  const [devOpen, setDevOpen] = useState(() => store.get('p3.dev') === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const [page, setPage] = useState<InfoPage | null>(null);
  /** CHANGES_7 §10: on narrow screens the side sections open with toggles. */
  const [side, setSide] = useState<'bets' | 'rounds' | null>(null);
  const [overlay, setOverlay] = useState(() => store.get('p3.overlay') === '1' || params.has('perf'));
  const [pick, setPick] = useState<Pick | null>(null);
  const [amount, setAmount] = useState('1.00');
  /** A bet queued with "Place bet on random tile for next round" (amount in minor units). */
  const [queued, setQueued] = useState<number | null>(null);
  /** CHANGES_5 §2: bumps when a tile is tapped while not in the game; the bet section pulses yellow. */
  const [nudge, setNudge] = useState(0);
  /** CHANGES_9 C3: with a queued bet, a tile tap lights the message box instead. */
  const [msgNudge, setMsgNudge] = useState(0);
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
  // CHANGES_7 §9 "My bets": this session's own results.
  const you = s.you;
  const lastAliveX = useRef(0);
  if (you?.state === 'alive' && r && you.roundId === r.roundId) lastAliveX.current = r.stage === 1 && r.removed === 0 ? 0 : r.multiplier;
  useEffect(() => {
    if (!you || !r || you.roundId !== r.roundId || r.phase !== 'ended' || you.state === 'idle' || you.state === 'betting') return;
    const reach = you.state === 'cashedOut' ? (you.multiplier ?? 0) : you.state === 'lost' ? lastAliveX.current : r.multiplier;
    myBets.record({ roundId: you.roundId, bet: you.bet, state: you.state, multiplier: you.multiplier, payout: you.payout, reach });
  }, [you, r?.phase, r?.roundId]); // eslint-disable-line react-hooks/exhaustive-deps
  // CHANGES_9 J1: on narrow screens the page is fixed until a side section is opened; scrolling back to the top closes it.
  useEffect(() => {
    const narrow = () => window.matchMedia('(max-width: 1099px)').matches;
    document.documentElement.classList.toggle('locked', narrow() && side === null);
    if (side === null) return;
    let away = false;
    const onScroll = () => {
      if (window.scrollY > 40) away = true;
      else if (away && window.scrollY <= 0) setSide(null);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    if (narrow()) requestAnimationFrame(() => document.querySelector(side === 'bets' ? '.left-col' : '.right-col')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return () => window.removeEventListener('scroll', onScroll);
  }, [side]);
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
        <div className="hbalance" aria-label="Balance">
          {sym}
          {formatMoney(s.balance)}
        </div>
        <SettingsMenu
          s={s}
          open={menuOpen}
          setOpen={setMenuOpen}
          onPage={setPage}
          onFair={() => setFairOpen(true)}
          onDev={() => {
            store.set('p3.dev', '1');
            setDevOpen(true);
          }}
        />
      </header>

      {!s.connected && <div className="banner warn">Starting the game engine…</div>}

      <main className="layout">
        <section className="center-col" aria-label="Game">
          <Board
            s={s}
            spectating={spectating}
            pick={pick}
            setPick={setPick}
            onNudge={() => (queued !== null ? setMsgNudge((n) => n + 1) : setNudge((n) => n + 1))}
            onBetTile={(t) => {
              const minor = Math.round(Number(amount) * 100);
              const cfg = s.config;
              if (cfg && Number.isFinite(minor) && minor >= cfg.minBet && minor <= cfg.maxBet) client.bet(minor, t);
              else client.notify('Enter a valid bet amount');
            }}
          />
          <div className="under">
            <MultiplierSection s={s} pick={pick} queued={queued} nudge={msgNudge} />
            {!spectating && <BetSection s={s} pick={pick} amount={amount} setAmount={setAmount} queued={queued} setQueued={setQueued} nudge={nudge} />}
          </div>
          <div className="side-toggles" role="group" aria-label="Show a side section">
            <button className={`side-toggle ${side === 'bets' ? 'on' : ''}`} aria-pressed={side === 'bets'} onClick={() => setSide(side === 'bets' ? null : 'bets')}>
              Live bets
            </button>
            <button className={`side-toggle ${side === 'rounds' ? 'on' : ''}`} aria-pressed={side === 'rounds'} onClick={() => setSide(side === 'rounds' ? null : 'rounds')}>
              History
            </button>
          </div>
        </section>
        <aside className={`left-col ${side === 'bets' ? 'side-open' : ''}`} aria-label="Live bets">
          <LiveBets s={s} sym={sym} />
        </aside>
        <aside className={`right-col ${side === 'rounds' ? 'side-open' : ''}`} aria-label="History">
          <RoundsPanel s={s} sym={sym} top={topResults} onOpen={setDetailsFor} />
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
      {page && (
        <InfoModal
          page={page}
          s={s}
          sym={sym}
          onClose={() => setPage(null)}
          onOpenRound={(id) => {
            setPage(null);
            setDetailsFor(id);
          }}
        />
      )}
      {devOpen && (
        <SettingsPanel
          s={s}
          client={client}
          overlay={overlay}
          setOverlay={setOverlay}
          onNewIdentity={s.session?.provider === 'demo' ? newDemoIdentity : undefined}
          onClose={() => {
            store.set('p3.dev', '0');
            setDevOpen(false);
          }}
        />
      )}
      {overlay && <StressOverlay s={s} client={client} />}
    </div>
  );
}

type InfoPage = 'howToPlay' | 'limits' | 'myBets';

/** CHANGES_7 §9: "My bets" for this session (kept in memory only). */
interface MyBet {
  roundId: string;
  bet: number;
  state: string;
  multiplier: number | null;
  payout: number;
  /** CHANGES_9 H1: cash-out x, or the x the player last stood at. */
  reach: number;
}
const myBets = {
  list: [] as MyBet[],
  record(b: MyBet) {
    if (this.list[0]?.roundId === b.roundId) return;
    this.list = [b, ...this.list].slice(0, 50);
  },
};

/** Header settings button and menu, as in Dicador (CHANGES_7 §9). */
function SettingsMenu({
  s,
  open,
  setOpen,
  onPage,
  onFair,
  onDev,
}: {
  s: GameState;
  open: boolean;
  setOpen: (v: boolean) => void;
  onPage: (p: InfoPage) => void;
  onFair: () => void;
  onDev: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open, setOpen]);
  const name = s.session ? maskName(s.session.displayName) : '';
  const item = (label: string, fn: () => void) => (
    <button
      role="menuitem"
      className="menu-item"
      onClick={() => {
        setOpen(false);
        fn();
      }}
    >
      {label}
    </button>
  );
  return (
    <div className="settings" ref={ref}>
      <button className="settings-btn" aria-haspopup="menu" aria-expanded={open} aria-label="Settings" onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden>
          {(s.session?.displayName ?? '?').slice(0, 1)}
        </span>
        <span className="settings-name">{name}</span>
        <span className="caret" aria-hidden>
          ▾
        </span>
      </button>
      {open && (
        <div className="menu" role="menu" aria-label="Settings menu">
          <div className="menu-head">
            <span className="avatar big" aria-hidden>
              {(s.session?.displayName ?? '?').slice(0, 1)}
            </span>
            <div>
              <strong>{s.session?.displayName}</strong>
              <div className="muted small">{s.session?.mode === 'real' ? 'Player' : 'Demo player'} · play money</div>
            </div>
          </div>
          {item('How to play', () => onPage('howToPlay'))}
          {item('Game limits', () => onPage('limits'))}
          {item('Provably fair', onFair)}
          {item('My bets', () => onPage('myBets'))}
          {item('Dev panel', onDev)}
        </div>
      )}
    </div>
  );
}

function InfoModal({ page, s, sym, onClose, onOpenRound }: { page: InfoPage; s: GameState; sym: string; onClose: () => void; onOpenRound: (id: string) => void }) {
  const inSession = new Set(s.history.map((h) => h.roundId));
  const cfg = s.config;
  const title = page === 'howToPlay' ? `How to play ${GAME_TITLE}` : page === 'limits' ? 'Game limits' : 'My bets';
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="info-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="info-title">{title}</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {page === 'howToPlay' && <HowToPlayText />}
        {page === 'limits' && cfg && (
          <dl className="kv">
            <dt>Minimum bet</dt>
            <dd>
              {sym}
              {formatMoney(cfg.minBet)}
            </dd>
            <dt>Maximum bet</dt>
            <dd>
              {sym}
              {formatMoney(cfg.maxBet)}
            </dd>
            <dt>Maximum win per bet</dt>
            <dd>
              {sym}
              {formatMoney(cfg.maxWinPerBet)}
            </dd>
            <dt>Top multiplier</dt>
            <dd>{formatMultiplier(TOP_MULTIPLIER)}</dd>
            <dt>Tile lock</dt>
            <dd>{cfg.tileCapPct}% of the round's bets</dd>
          </dl>
        )}
        {page === 'myBets' && (
          <table className="rounds">
            <thead>
              <tr>
                <th scope="col">Round</th>
                <th scope="col">Bet</th>
                <th scope="col">Reach x</th>
                <th scope="col">Cashout x</th>
                <th scope="col">Win</th>
              </tr>
            </thead>
            <tbody>
              {myBets.list.map((b) => (
                <tr key={b.roundId}>
                  <td>
                    {inSession.has(b.roundId) ? (
                      <button className="link" onClick={() => onOpenRound(b.roundId)} title={`${b.roundId}: details and verification`}>
                        #{b.roundId.split('#')[1]}
                      </button>
                    ) : (
                      <span>#{b.roundId.split('#')[1]}</span>
                    )}
                  </td>
                  <td>
                    {sym}
                    {formatMoney(b.bet)}
                  </td>
                  <td>{formatMultiplier(b.reach)}</td>
                  <td className="win">{b.state === 'cashedOut' && b.multiplier !== null ? formatMultiplier(b.multiplier) : ''}</td>
                  <td className="win">
                    {b.state === 'cashedOut' ? `${sym}${formatMoney(b.payout)}` : ''}
                  </td>
                </tr>
              ))}
              {myBets.list.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted">
                    No bets in this session yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
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

function HowToPlayText() {
  return (
    <>
      <p className="muted small">
        While betting is open the game picks a random tile for you; tap another tile to choose your own, then bet. Tiles go one by
        one and the multiplier climbs after every one. Cash out before your tile goes, or survive all three stages ({stageName(1)},{' '}
        {stageName(2)}, {stageName(3)}; the board comes back between them) to win {formatMultiplier(TOP_MULTIPLIER)} on the last tile
        standing. When the round starts, a tile with {DEFAULT_CONFIG.tileCapPct}% of the bets on it is locked (red). Empty tiles are
        green, occupied tiles yellow. Play money only.
      </p>
    </>
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

/** Tiles gone so far in the whole round (1–280), counting a finished stage in full during resurrection. */
function tilesGoneInRound(r: NonNullable<GameState['round']>): number {
  const before = STAGE_REMOVALS.slice(0, r.stage - 1).reduce((a, b) => a + b, 0);
  return before + (r.phase === 'intermission' ? STAGE_REMOVALS[r.stage - 1] : r.removed);
}

/** Message line 2 (CHANGES_7 §6): only countdowns and the tile count. */
function gameLine(s: GameState, now: number): string {
  const r = s.round!;
  const secs = r.phaseEndsAt ? Math.max(0, (r.phaseEndsAt - now) / 1000).toFixed(1) : '0.0';
  if (r.phase === 'betting') return `Betting closes in ${secs} s`;
  if (r.phase === 'intermission') return `${stageName(r.stage + 1)} starts in ${secs} s`;
  if (r.phase === 'ended') return `Next round in ${secs} s`;
  // CHANGES_9 D1: counts up, per stage.
  const len = STAGE_REMOVALS[r.stage - 1];
  return `Tiles ${r.removed}/${len}`;
}

/** Message line 1 (CHANGES_7 §6): the player's messages, else game events (resurrection, round result). */
function playerLine(s: GameState, now: number, pick: Pick | null, queued: number | null): { text: string; kind: string } {
  const r = s.round!;
  const cur = s.config?.currency ?? '';
  const you = s.you?.roundId === r.roundId ? s.you : null;
  // CHANGES_9 B5: a rejected action (tile full, …) for 3 s.
  if (s.notice && Date.now() - s.notice.at < 3_000) return { text: s.notice.text, kind: 'loss' };
  if (you?.state === 'betting') return { text: 'Bet placed. Tap a tile to move', kind: 'me' };
  if (you?.state === 'alive') {
    if (r.phase === 'intermission') return { text: `You survived ${stageName(r.stage)}! Move or cash out`, kind: 'win' };
    return { text: "You're in the game", kind: 'me' };
  }
  if (you?.state === 'cashedOut') return { text: `Cashed out ${formatMultiplier(you.multiplier ?? 0)} · ${formatMoney(you.payout)} ${cur}`, kind: 'win' };
  // CHANGES_8 §7: "Your tile is gone" for 5 s, then the bet prompt again.
  if (you?.state === 'lost' && s.lostAt !== null && now - (s.lostAt + s.offset) < 5000) return { text: 'Your tile is gone', kind: 'loss' };
  if (queued !== null) return { text: 'Your bet goes on a random tile next round', kind: 'me' };
  if (r.phase === 'betting') {
    return pick && !pick.random ? { text: 'Tap the tile again to bet', kind: 'hint' } : { text: 'Bet random or choose tile', kind: 'hint' };
  }
  if (r.phase === 'intermission') {
    const tiles = r.survived?.filter(Boolean).length ?? 0;
    const players = r.counts.reduce((a, b) => a + b, 0);
    return { text: `Resurrection! ${tiles} tiles survived with ${players} player${players === 1 ? '' : 's'}`, kind: 'resurrect' };
  }
  if (r.phase === 'ended') {
    const last = s.revealed[0]?.roundId === r.roundId ? s.revealed[0] : null;
    if (last?.survivorsPaid.length) return { text: `${last.survivorsPaid.length} won ${formatMultiplier(TOP_MULTIPLIER)}!`, kind: 'win' };
    if (last?.emptiedAtStage) return { text: `Round over at ${stageName(last.emptiedAtStage)}`, kind: 'info' };
    return { text: 'Round over', kind: 'info' };
  }
  return { text: 'Bet now for the next round', kind: 'hint' };
}

/**
 * Under the grid, left (fixed size): stage tabs 10x / 100x / 10kx, the multiplier, the two-line message box
 * (thin grey frame) and "Tiles left: X of Y". Bronze / silver / gold frame by stage.
 */
function MultiplierSection({ s, pick, queued, nudge }: { s: GameState; pick: Pick | null; queued: number | null; nudge: number }) {
  const now = useNow();
  const r = s.round;
  if (!r) return <div className="mbox" />;
  const resurrected = r.phase === 'intermission';
  const shownStage = resurrected ? Math.min(3, r.stage + 1) : r.stage;
  const top = playerLine(s, now, pick, queued);
  const game = gameLine(s, now);
  // CHANGES_7 §6: 0.00x until the first tile goes (not 1.00x falling to 0.98x).
  const notStarted = r.stage === 1 && r.removed === 0 && (r.phase === 'betting' || r.phase === 'running');
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
        {formatMultiplier(notStarted ? 0 : r.multiplier)}
      </div>
      <div className={`msgbox ${nudge ? `nudge-${nudge % 2}` : ''}`} role="status" aria-live="polite">
        <Marquee text={top.text} />
        <Marquee text={game} />
      </div>
    </div>
  );
}

/** CHANGES_8 §6: one line; text wider than the box scrolls like a ticker. */
function Marquee({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  useEffect(() => {
    const el = box.current;
    const span = el?.firstElementChild as HTMLElement | null;
    if (!el || !span) return;
    const d = span.scrollWidth - el.clientWidth;
    setLong(d > 1);
    if (d <= 1 || !span.animate) return;
    // CHANGES_9 C1: wait 1 s, scroll to the end at ~40 px/s, wait 1 s, scroll back, wait 1 s, then stay still.
    const move = (d / 40) * 1000;
    const total = 3_000 + 2 * move;
    const at = (ms: number) => ms / total;
    const anim = span.animate(
      [
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(0)', offset: at(1_000) },
        { transform: `translateX(${-d}px)`, offset: at(1_000 + move) },
        { transform: `translateX(${-d}px)`, offset: at(2_000 + move) },
        { transform: 'translateX(0)', offset: at(2_000 + 2 * move) },
        { transform: 'translateX(0)', offset: 1 },
      ],
      { duration: total, easing: 'linear' },
    );
    return () => anim.cancel();
  }, [text]);
  return (
    <div className={`msg-line ${long ? 'long' : ''}`} ref={box} title={text}>
      <span>{text}</span>
    </div>
  );
}

function Board({
  s,
  spectating,
  pick,
  setPick,
  onNudge,
  onBetTile,
}: {
  s: GameState;
  spectating: boolean;
  pick: Pick | null;
  setPick: (p: Pick) => void;
  onNudge: () => void;
  onBetTile: (tile: number) => void;
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
  // CHANGES_8 §1: at round end the stage's other standing tiles go fast (precommitted order) and only its
  // surviving tile stays, with the gold frame.
  const ended = r.phase === 'ended';
  const last = ended && s.revealed[0]?.roundId === r.roundId ? s.revealed[0] : null;
  // CHANGES_9 A1: stages 1 and 2 keep their 9 / 10 standing tiles; only stage 3 ends with one tile.
  const tail = last?.stageTail ?? [];
  const standing = new Set(tail);
  const goneAt = (t: number) => (ended && tail.length ? !standing.has(t) : r.gone[t]);
  const isWinner = (t: number) => ended && standing.has(t);

  const onTile = (t: number) => {
    // Not in the game (no bet, cashed out or lost): point at the bet section.
    if (!spectating && myTile === null && !canPick) return onNudge();
    if (goneAt(t)) return;
    if (canMove && t !== myTile) client.move(t);
    // CHANGES_9 B3: tapping the framed tile again places the bet.
    else if (canPick && pick?.tile === t) onBetTile(t);
    else if (canPick) setPick({ tile: t, random: false });
  };

  return (
    <div className="board-wrap">
    <LoadingScreen s={s} />
    {r.phase === 'betting' && you?.state !== 'betting' && (
      <div className="betnow" aria-hidden>
        <span>BET</span>
        <span>NOW</span>
      </div>
    )}
    <div className={`board ${r.fast ? 'fast' : ''} ${r.phase === 'intermission' ? 'resurrect' : ''}`} role="grid" aria-label="10 by 10 tile grid">
      {r.counts.map((count, t) => {
        const gone = goneAt(t);
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
          isWinner(t) ? 'winner' : '',
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
              isWinner(t) ? ', survived the stage' : pickedTile === t ? ', tap again to bet' : ''
            }`}
          >
            {mine && <span className="you-badge">ME</span>}
            {pickedTile === t && <span className="tag-bet">Bet</span>}
            <span className="tile-count">{gone ? '×' : count}</span>
            {pickedTile === t && <span className="tag-now">Now</span>}
          </button>
        );
      })}
    </div>
    </div>
  );
}

/** CHANGES_7 §5: the last loadingMs of the round-over pause cover the board (logo placeholder + progress). */
function LoadingScreen({ s }: { s: GameState }) {
  const r = s.round;
  const now = useNow(50, r?.phase === 'betting');
  const ms = s.config?.loadingMs ?? 3_000;
  const betting = s.config?.bettingMs ?? 10_000;
  if (!r || r.phase !== 'betting' || !r.phaseEndsAt) return null;
  // CHANGES_9 F2: betting is already open under the loading screen.
  const elapsed = betting - (r.phaseEndsAt - now);
  if (elapsed >= ms) return null;
  const done = Math.min(1, Math.max(0, elapsed / ms));
  return (
    <div className="loading" role="status" aria-label="Loading the next round">
      <div className="loading-logo">
        <span className="logo" aria-hidden>
          ▦
        </span>
        {GAME_TITLE}
      </div>
      <div className="loading-bar" aria-hidden>
        <span style={{ width: `${done * 100}%` }} />
      </div>
      <div className="muted small">Next round</div>
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
  const valid = amount !== '' && Number.isFinite(minor) && minor >= cfg.minBet && minor <= cfg.maxBet;
  const clamp = (v: number) => Math.min(cfg.maxBet, Math.max(cfg.minBet, Math.round(v)));
  const setMinor = (v: number) => setAmount(formatAmount(clamp(v)));
  // − / + on the step grid; read the latest amount through a ref while the button is held.
  const minorRef = useRef(minor);
  minorRef.current = Number.isFinite(minor) ? minor : cfg.minBet;
  const step = (dir: 1 | -1) => {
    const next = clamp(stepBet(minorRef.current, dir, cfg.minBet, cfg.maxBet));
    minorRef.current = next;
    setAmount(formatAmount(next));
  };
  const minus = useHoldRepeat(() => step(-1));
  const plus = useHoldRepeat(() => step(1));
  // CHANGES_8 §8: no bet when betting closed: the main button fades for 3 s before a next-round bet is allowed.
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const startedRound = r?.phase === 'running' && r.stage === 1 ? r.roundId : null;
  useEffect(() => {
    if (startedRound) setClosedAt(client.serverNow());
  }, [startedRound]);
  const now = useNow(100, closedAt !== null);
  const potential = useMemo(() => {
    if (!you || !r || you.state !== 'alive') return 0;
    return payout(you.bet, Math.round(r.multiplier * 100), cfg.maxWinPerBet);
  }, [you, r, cfg.maxWinPerBet]);
  if (!r) return <div className="betbox" />;

  let main: { text: string; color: 'green' | 'yellow' | 'red'; onClick: () => void; disabled?: boolean; fading?: boolean };
  if (r.phase === 'betting' && you?.state === 'betting') {
    main = { text: `Cancel bet ${formatMoney(you.bet)} ${cur}`, color: 'red', onClick: () => client.cancelBet() };
  } else if (r.phase === 'betting') {
    main = { text: `Bet ${formatMoney(valid ? minor : 0)} ${cur}`, color: 'green', disabled: !pick || !valid, onClick: () => pick && client.bet(minor, pick.tile) };
  } else if (you?.state === 'alive') {
    const open = r.phase === 'intermission' || (r.phase === 'running' && !(r.stage === 1 && r.removed === 0));
    main = { text: `Cash out ${formatMoney(potential)} ${cur}`, color: 'yellow', disabled: !open, onClick: () => client.cashout() };
  } else if (queued !== null) {
    main = { text: `Cancel bet ${formatMoney(queued)} ${cur}`, color: 'red', onClick: () => setQueued(null) };
  } else {
    const fading = closedAt !== null && now - closedAt < 3_000 && r.phase === 'running' && (!you || you.state === 'idle');
    main = { text: `Bet ${formatMoney(valid ? minor : 0)} ${cur}`, color: 'green', disabled: !valid || fading, fading, onClick: () => setQueued(minor) };
  }

  return (
    <div className={`betbox ${nudge ? `nudge-${nudge % 2}` : ''}`}>
      <button className={`mainbtn mb-${main.color}${main.fading ? ' fading' : ''}`} disabled={main.disabled} onClick={main.onClick}>
        <span className="cta">{main.text}</span>
      </button>
      <div className="amount-row">
        <div className="amount-group">
          <button className="step" aria-label="Decrease bet" {...minus}>
            −
          </button>
          <input className="amount" inputMode="decimal" aria-label={`Bet amount in ${cur}`} value={amount}
            onChange={(e) => {
              const v = e.target.value.replace(',', '.');
              if (AMOUNT_RE.test(v)) setAmount(v);
            }}
            onBlur={() => setMinor(Number.isFinite(minor) && amount !== '' ? minor : cfg.minBet)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <button className="step" aria-label="Increase bet" {...plus}>
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
  const mine = { row: null as PublicBet | null };
  const listed = (f?.bets ?? []).map((b) => {
    if (!mine.row && you && b.nickname === myMask && b.bet === you.bet && b.tile === you.tileId) {
      mine.row = b;
      return { ...b, me: true };
    }
    return { ...b, me: false };
  });
  const money = (v: number) => `${sym}${formatMoney(v)}`;
  // CHANGES_7 §2: tiles survived in the whole round; live players show the tiles gone so far.
  const goneNow = r && r.phase !== 'betting' ? tilesGoneInRound(r) : null;
  // My own row may be outside the engine's 50 listed rows: remember the tile count when I cash out or crash.
  const myTiles = useRef<{ roundId: string; tiles: number; crashX: number | null } | null>(null);
  const lastX = useRef(0);
  const liveX = r && !(r.stage === 1 && r.removed === 0) ? r.multiplier : 0;
  if (you && goneNow !== null && (you.state === 'cashedOut' || you.state === 'lost') && myTiles.current?.roundId !== you.roundId) {
    myTiles.current = { roundId: you.roundId, tiles: you.state === 'lost' ? Math.max(0, goneNow - 1) : goneNow, crashX: you.state === 'lost' ? lastX.current : null };
  }
  if (you?.state === 'alive') lastX.current = liveX;
  // CHANGES_8 §5: x for everyone (cashed: cash-out x; live: current x; crashed: x they last stood at).
  const xCell = (b: { state: string; multiplier: number | null; crashMultiplier?: number | null }) =>
    b.state === 'cashedOut' ? b.multiplier : b.state === 'alive' ? liveX : b.state === 'lost' ? (b.crashMultiplier ?? null) : null;
  // CHANGES_9 F1: my row sits in its normal sorted place; if the engine did not list it, insert it there.
  const myName = s.session ? `${s.session.displayName} (Me)` : 'Me';
  const rows = [...listed];
  if (you && !mine.row) {
    const meRow = {
      nickname: myMask,
      bet: you.bet,
      tile: you.tileId ?? 0,
      state: you.state,
      multiplier: you.multiplier,
      payout: you.payout,
      survived: myTiles.current?.roundId === you.roundId ? myTiles.current.tiles : null,
      crashMultiplier: myTiles.current?.roundId === you.roundId ? myTiles.current.crashX : null,
      me: true,
    };
    const group = (st: string) => (st === 'alive' || st === 'betting' ? 0 : st === 'cashedOut' ? 1 : 2);
    const key = (b: typeof meRow) => (b.state === 'cashedOut' ? (b.multiplier ?? 0) : b.bet);
    let i = rows.findIndex((b) => group(b.state) > group(meRow.state) || (group(b.state) === group(meRow.state) && key(b) < key(meRow)));
    if (i < 0) i = rows.length;
    rows.splice(i, 0, meRow);
  }
  const tilesCell = (b: { state: string; survived?: number | null }) =>
    b.state === 'cashedOut' || b.state === 'lost' ? (b.survived ?? '') : b.state === 'alive' && goneNow !== null ? goneNow : '';
  const row = (key: string | number, name: string, b: { bet: number; state: string; multiplier: number | null; payout: number; survived?: number | null; crashMultiplier?: number | null }, me = false) => (
    <tr key={key} className={`st-${b.state}${me ? ' me' : ''}`}>
      <td className="nick">{name}</td>
      <td>{money(b.bet)}</td>
      <td>{tilesCell(b)}</td>
      <td>{(() => {
        const x = xCell(b);
        return x === null || b.state === 'betting' ? '' : formatMultiplier(x);
      })()}</td>
      <td>{b.state === 'cashedOut' ? money(b.payout) : ''}</td>
    </tr>
  );
  return (
    <div className="panel livebets">
      <h2>Live bets</h2>
      <div className="lb-head">
        <div>
          <div className="lb-label">Bets</div>
          <div className="lb-big">
            {(f?.totals.alive ?? 0).toLocaleString()} <span className="muted">/ {(f?.totals.players ?? 0).toLocaleString()}</span>
          </div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div className="lb-label">Total cashout</div>
          <div className="lb-big win">{money(f?.stats.paid ?? 0)}</div>
        </div>
        {r && (() => {
          const st = r.phase === 'intermission' ? Math.min(3, r.stage + 1) : r.stage;
          return (
            <span className={`stage-pill on lb-stage metal-${METAL[st - 1]}`} aria-label={`Stage ${stageName(st)}`}>
              {stageName(st)}
            </span>
          );
        })()}
      </div>
      <table className="lbtable">
        <thead>
          <tr>
            <th scope="col">Player</th>
            <th scope="col">Bet</th>
            <th scope="col" title="Tiles survived in the round">Tiles</th>
            <th scope="col">x</th>
            <th scope="col">Win</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b, i) => row(b.me ? 'me' : i, b.me ? myName : b.nickname, b, b.me))}
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
    <button className={`sortbtn ${sort === k ? 'on' : ''}`} aria-pressed={sort === k} onClick={() => setSort(k)} title={`Sort by ${label}`}>
      {label} <span aria-hidden>▼</span>
    </button>
  );
  return (
    <div className="panel rounds-panel">
      <h2>History</h2>
      <div className="rp-max">
        All rounds: max <b className="gold">{formatMultiplier(TOP_MULTIPLIER)}</b> · Tiles <b>{STAGE_REMOVALS.reduce((a, b) => a + b, 0)}</b>
      </div>
      <div className="rp-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`rp-tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>
      <table className="rounds">
        <thead>
          <tr>
            <th scope="col">Round</th>
            <th scope="col">
              Top man
              {isTop && <div className="sortrow">{sortBtn('man', 'x')}</div>}
            </th>
            <th scope="col">
              Top cashout
              {isTop && (
                <div className="sortrow">
                  {sortBtn('cashX', 'x')}
                  {sortBtn('cashWin', 'Win')}
                </div>
              )}
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
                  <div className="sub">Reach {stageName(h.reached)}</div>
                </td>
                <td>
                  {tm ? (
                    <>
                      <b className="mult-cell gold-x">{formatMultiplier(tm.multiplier)}</b>
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
