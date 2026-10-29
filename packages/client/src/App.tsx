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
  formatMultiplier,
  stageName,
  tileBand,
  tileCapsFor,
  type TileCaps,
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

  const r = s.round;
  const phase = r?.phase;
  const roundId = r?.roundId;
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
        <section className="center-col" aria-label="Game">
          <Board s={s} spectating={spectating} pick={pick} setPick={setPick} />
          <div className="under">
            <MultiplierSection s={s} />
            {!spectating && <BetSection s={s} pick={pick} amount={amount} setAmount={setAmount} queued={queued} setQueued={setQueued} />}
          </div>
        </section>
        <aside className="left-col" aria-label="Players and stats">
          <PlayersPanel s={s} sym={sym} />
        </aside>
        <aside className="right-col" aria-label="Past games">
          <History s={s} />
          <Rooms s={s} />
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
        While betting is open the game picks a random tile for you (white outline); tap another tile to choose your own, then
        bet. Tiles go one by one and the multiplier climbs after every one. Cash out before your tile goes, or survive all three
        volumes (the board comes back after {stageName(1)} and {stageName(2)}) to win 10,000x on the last tile standing. When the
        round starts, tiles holding 10% of the bets are locked (red); from 5% they are yellow. Play money only.
      </p>
    </details>
  );
}

const METAL = ['bronze', 'silver', 'gold'] as const;

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

/** Status line for the multiplier section (CHANGES_4 §1). */
function statusText(s: GameState, now: number, sym: string): { text: string; kind: string } {
  const r = s.round!;
  const secs = r.phaseEndsAt ? Math.max(0, (r.phaseEndsAt - now) / 1000).toFixed(1) : null;
  const you = s.you?.roundId === r.roundId ? s.you : null;
  if (r.phase === 'betting') return { text: `Betting closes in ${secs} s`, kind: 'info' };
  if (r.phase === 'intermission') {
    const tiles = r.survived?.filter(Boolean).length ?? 0;
    const players = r.counts.reduce((a, b) => a + b, 0);
    return {
      text: `Resurrection! ${tiles} tiles survived ${stageName(r.stage)} with ${players} player${players === 1 ? '' : 's'}. ${
        you?.state === 'alive' ? 'Move or cash out now. ' : ''
      }${stageName(r.stage + 1)} in ${secs} s`,
      kind: 'resurrect',
    };
  }
  if (r.phase === 'ended') {
    const last = s.revealed[0]?.roundId === r.roundId ? s.revealed[0] : null;
    const result = last
      ? last.emptiedAtStage
        ? `No survivors at ${stageName(last.emptiedAtStage)}. 10,000x tile was #${last.jackpotTile + 1}.`
        : `${last.survivorsPaid.length} won 10,000x on tile #${last.jackpotTile + 1}!`
      : '';
    const mine = you?.state === 'cashedOut' ? ` You won ${sym}${formatMoney(you.payout)}.` : '';
    return { text: `Round over. ${result}${mine} Next round in ${secs} s`, kind: you?.state === 'cashedOut' ? 'win' : 'info' };
  }
  if (you?.state === 'lost' && s.lostAt !== null && now - (s.lostAt + s.offset) < 3000) return { text: 'Your tile is gone.', kind: 'loss' };
  if (r.fast) return { text: 'No players left, finishing fast', kind: 'info' };
  if (r.removed === 0 && r.stage === 1) return { text: 'Round started. First tile about to go', kind: 'info' };
  return { text: `${stageName(r.stage)}: tiles going`, kind: 'info' };
}

/** Under the grid, left: vertical Vol. tabs, multiplier, status and tiles left (bronze/silver/gold frame). */
function MultiplierSection({ s }: { s: GameState }) {
  const now = useNow();
  const r = s.round;
  if (!r) return <div className="mbox" />;
  const resurrected = r.phase === 'intermission';
  const shownStage = resurrected ? Math.min(3, r.stage + 1) : r.stage;
  const stageLen = STAGE_REMOVALS[shownStage - 1];
  const removed = resurrected ? 0 : r.removed;
  const status = statusText(s, now, CURRENCY_SYMBOL[s.config?.currency ?? ''] ?? '');
  return (
    <div className={`mbox metal-${METAL[shownStage - 1]} phase-${r.phase}`}>
      <div className="stages" role="tablist" aria-label={`${stageName(shownStage)} of 3`}>
        {[1, 2, 3].map((n) => (
          <span key={n} role="tab" aria-selected={n === shownStage} className={`stage-pill metal-${METAL[n - 1]} ${n === shownStage ? 'on' : n < shownStage ? 'done' : ''}`}>
            {stageName(n)}
          </span>
        ))}
      </div>
      <div className="mmain">
        <div className="mult" aria-live="polite" aria-atomic="true">
          {formatMultiplier(r.multiplier)}
        </div>
        <div className={`mstatus msg-${status.kind}`} role="status" aria-live="polite">
          {status.text}
        </div>
        <div className="mtiles">
          Tiles left: <b>{100 - removed}</b> <span className="muted">({removed}/{stageLen} gone)</span>
        </div>
      </div>
    </div>
  );
}

function Board({ s, spectating, pick, setPick }: { s: GameState; spectating: boolean; pick: Pick | null; setPick: (p: Pick) => void }) {
  const r = s.round;
  const caps = useCaps(s);
  const you = s.you && r && s.you.roundId === r.roundId ? s.you : null;
  const myTile = you && (you.state === 'alive' || you.state === 'betting') ? you.tileId : null;
  if (!r || !caps) return <div className="board" />;
  const canMove = !spectating && myTile !== null && (r.phase === 'betting' || r.phase === 'running' || r.phase === 'intermission');
  const canPick = !spectating && r.phase === 'betting' && (!you || you.state === 'idle');
  const pickedTile = canPick ? pick?.tile : null;
  // Your bet's frame: bronze while betting and in Vol. 1, then silver, then gold.
  const metal = METAL[(r.phase === 'intermission' ? Math.min(3, r.stage + 1) : r.stage) - 1];

  const onTile = (t: number) => {
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
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <button
            key={`${r.stage}-${t}`}
            className={cls}
            onClick={() => onTile(t)}
            disabled={gone}
            aria-label={`Tile ${t + 1}: ${gone ? 'gone' : band === 'full' ? `locked, ${count} players` : `${count} players`}${mine ? ', your tile' : pickedTile === t ? ', selected' : ''}`}
          >
            {mine && <span className="you-badge">YOU</span>}
            <span className="tile-count">{gone ? '×' : count}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Under the grid, right: the main button (CHANGES_4 §2) and the amount row. */
function BetSection({
  s,
  pick,
  amount,
  setAmount,
  queued,
  setQueued,
}: {
  s: GameState;
  pick: Pick | null;
  amount: string;
  setAmount: (v: string) => void;
  queued: number | null;
  setQueued: (v: number | null) => void;
}) {
  const r = s.round;
  const cfg = s.config!;
  const cur = cfg.currency;
  const you = s.you && r && s.you.roundId === r.roundId ? s.you : null;
  const minor = Math.round(Number(amount) * 100);
  const valid = Number.isFinite(minor) && minor >= cfg.minBet && minor <= cfg.maxBet;
  const clamp = (v: number) => Math.min(cfg.maxBet, Math.max(cfg.minBet, Math.round(v)));
  const setMinor = (v: number) => setAmount((clamp(v) / 100).toFixed(2));
  const potential = useMemo(() => {
    if (!you || !r || you.state !== 'alive') return 0;
    return payout(you.bet, Math.round(r.multiplier * 100), cfg.maxWinPerBet);
  }, [you, r, cfg.maxWinPerBet]);
  if (!r) return <div className="betbox" />;

  let main: { text: string; color: 'green' | 'yellow' | 'red'; onClick: () => void; disabled?: boolean };
  if (r.phase === 'betting') {
    if (you?.state === 'betting') main = { text: `Cancel bet ${formatMoney(you.bet)} ${cur}`, color: 'red', onClick: () => client.cancelBet() };
    else
      main = {
        text: pick ? `Bet ${formatMoney(minor || 0)} ${cur} on ${pick.random ? 'random' : 'your'} tile #${pick.tile + 1}` : 'Choose a tile',
        color: 'green',
        disabled: !pick || !valid,
        onClick: () => pick && client.bet(minor, pick.tile),
      };
  } else if (you?.state === 'alive') {
    const open = r.phase === 'intermission' || (r.phase === 'running' && !(r.stage === 1 && r.removed === 0));
    main = {
      text: open ? `Cash out ${formatMoney(potential)} ${cur} now` : 'Cash out after the first tile goes',
      color: 'yellow',
      disabled: !open,
      onClick: () => client.cashout(),
    };
  } else if (queued !== null) {
    main = { text: `Cancel bet ${formatMoney(queued)} ${cur}`, color: 'red', onClick: () => setQueued(null) };
  } else {
    main = { text: 'Place bet on random tile for next round', color: 'green', disabled: !valid, onClick: () => setQueued(minor) };
  }

  return (
    <div className="betbox">
      <button className={`mainbtn mb-${main.color}`} disabled={main.disabled} onClick={main.onClick}>
        {main.text}
      </button>
      {queued !== null && r.phase !== 'betting' && <div className="small muted">Your bet will be placed on a random tile when betting opens.</div>}
      <div className="amount-row">
        <label htmlFor="amt">
          Bet <span className="cur">{cur}</span>
        </label>
        <input id="amt" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => valid || setMinor(minor || cfg.minBet)} />
        <button className="chip" onClick={() => setMinor(cfg.minBet)}>
          Min
        </button>
        <button className="chip" onClick={() => setMinor(cfg.maxBet)}>
          Max
        </button>
        {[1, 2, 5, 10].map((v) => (
          <button key={v} className="chip quick" onClick={() => setMinor(v * 100)} aria-label={`Bet ${v}.00 ${cur}`}>
            {v}
          </button>
        ))}
      </div>
    </div>
  );
}

function PlayersPanel({ s, sym }: { s: GameState; sym: string }) {
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
  const row = (b: { bet: number; tile: number | null; state: string; multiplier: number | null; payout: number }) =>
    b.state === 'cashedOut' ? (
      <span className="win">
        {b.multiplier !== null ? formatMultiplier(b.multiplier) : ""} · {money(b.payout)}
      </span>
    ) : b.state === 'lost' ? (
      <span className="loss">lost</span>
    ) : (
      <span className="muted">#{(b.tile ?? 0) + 1}</span>
    );
  return (
    <div className="panel players">
      <h2>Players</h2>
      <div className="totals">
        <div>
          <b>{f?.stats.inRoom ?? 0}</b>
          <span>in room</span>
        </div>
        <div>
          <b>{f?.totals.players ?? 0}</b>
          <span>bets</span>
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
      <dl className="kv stats">
        <dt>Total bet</dt>
        <dd>{money(f?.stats.staked ?? 0)}</dd>
        <dt>Total won</dt>
        <dd>{money(f?.stats.paid ?? 0)}</dd>
        <dt>Biggest win</dt>
        <dd>{f && f.stats.biggestWin > 0 ? `${money(f.stats.biggestWin)} (${formatMultiplier(f.stats.biggestMultiplier)})` : '–'}</dd>
        <dt>Tile locked at</dt>
        <dd>{!r ? '–' : r.phase === 'betting' ? 'locks at round start: 10% of bets' : `${r.caps.tileCap} players (10% of ${r.caps.playerBase} bets)`}</dd>
      </dl>
      <ol className="plist">
        <li className="phead">
          <span>Player</span>
          <span>Bet</span>
          <span>Status</span>
        </li>
        {you && (
          <li className="you">
            <span className="nick">You ({myMask})</span>
            <span>{money(you.bet)}</span>
            {row({ bet: you.bet, tile: you.tileId, state: you.state, multiplier: you.multiplier, payout: you.payout })}
          </li>
        )}
        {others.map((b, i) => (
          <li key={i} className={`st-${b.state}`}>
            <span className="nick">{b.nickname}</span>
            <span>{money(b.bet)}</span>
            {row(b)}
          </li>
        ))}
        {f && f.moreBets > 0 && <li className="muted more">+ {f.moreBets.toLocaleString()} more</li>}
        {(!f || f.bets.length === 0) && !you && <li className="muted">No bets yet</li>}
      </ol>
    </div>
  );
}

/** Right column: past games (content to be defined by the product owner; placeholder for now). */
function History({ s }: { s: GameState }) {
  return (
    <div className="panel">
      <h2>Past games</h2>
      <ul className="history">
        {s.history.slice(0, 15).map((h) => (
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
