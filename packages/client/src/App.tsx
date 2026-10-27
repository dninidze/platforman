import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { STAGE_REMOVALS, formatMoney, payout } from '@p3/shared';
import { FairnessModal } from './Fairness';
import { GameClient, type GameState } from './net';

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const client = new GameClient(wsUrl);
client.connect();

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

  if (!s.joined) return <JoinScreen connected={s.connected} />;
  const sym = CURRENCY_SYMBOL[s.config?.currency ?? ''] ?? '';
  const spectating = s.watching !== null && s.watching !== s.homeRoom;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="logo" aria-hidden>
            ▦
          </span>
          Platform 3
        </div>
        <div className="hstats">
          <Stat label="Balance" value={`${sym}${formatMoney(s.balance)}`} strong />
          <Stat label="Room" value={s.watching ?? '–'} />
          <Stat label="Round" value={s.round?.roundId.split('#')[1] ?? '–'} />
        </div>
        <button className="pf" onClick={() => setFairOpen(true)} title="Provably fair" aria-label="Provably fair: verify rounds">
          <span aria-hidden>🛡</span> <span className="pf-text">Fair</span>
        </button>
      </header>

      {!s.connected && <div className="banner warn">Reconnecting…</div>}
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
      {fairOpen && <FairnessModal s={s} onClose={() => setFairOpen(false)} />}
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

function JoinScreen({ connected }: { connected: boolean }) {
  const [nick, setNick] = useState(() => {
    try {
      return localStorage.getItem('p3.nickname') ?? '';
    } catch {
      return '';
    }
  });
  const valid = /^[A-Za-z0-9_-]{1,16}$/.test(nick);
  return (
    <div className="join">
      <form
        className="join-card"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) client.join(nick);
        }}
      >
        <h1>Platform 3</h1>
        <p className="muted">
          Pick a tile. Tiles go one by one. The multiplier climbs after every Gone tile. Cash out before yours goes, or ride
          three platforms to 10,000x.
        </p>
        <label htmlFor="nick">Nickname</label>
        <input id="nick" value={nick} maxLength={16} autoFocus onChange={(e) => setNick(e.target.value)} placeholder="e.g. tilehopper" />
        <button className="btn primary" disabled={!valid || !connected}>
          {connected ? 'Play with demo credits' : 'Connecting…'}
        </button>
        <p className="muted small">Play money only. New nicknames get 1,000 demo credits.</p>
      </form>
    </div>
  );
}

function MultiplierBar({ s }: { s: GameState }) {
  const now = useNow();
  const r = s.round;
  if (!r) return <div className="mbar" />;
  const left = 100 - r.removed;
  const stageLen = STAGE_REMOVALS[r.stage - 1];
  const stageOver = r.removed >= stageLen;
  const survive = !stageOver && left > 0 ? (left - 1) / left : null;
  const secs = r.phaseEndsAt ? Math.max(0, (r.phaseEndsAt - now) / 1000) : null;
  const phaseLabel =
    r.phase === 'betting'
      ? `Betting closes in ${secs?.toFixed(1)}s`
      : r.phase === 'intermission'
        ? `Resurrection – next platform in ${secs?.toFixed(1)}s`
        : r.phase === 'ended'
          ? `Next round in ${secs?.toFixed(1)}s`
          : r.fast
            ? 'No players left – finishing fast'
            : r.removed === 0 && r.stage === 1
              ? 'First tile about to go'
              : 'Tiles going…';
  return (
    <div className={`mbar phase-${r.phase}`}>
      <div className="stages" aria-label={`Platform ${r.stage} of 3`}>
        {[1, 2, 3].map((n) => (
          <span key={n} className={`stage-pill ${n === r.stage ? 'on' : n < r.stage ? 'done' : ''}`}>
            Platform {n}
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
            Tiles left: <b>{left}</b> <span className="muted">({r.removed}/{stageLen} gone)</span>
          </div>
          <div>
            Your tile survives next: <b>{survive !== null ? `${(survive * 100).toFixed(1)}%` : '–'}</b>
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
          <div>All tiles are back. Platform {r.stage + 1} starts soon.</div>
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
          {last.emptiedAtStage ? `No survivors at platform ${last.emptiedAtStage}.` : `${last.survivorsPaid.length} survivor(s) paid 10,000x!`} 10,000x tile was #
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
          <li key={i}>
            <span className="nick">{c.nickname}</span>
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
              {h.emptiedAtStage ? `no survivors at P${h.emptiedAtStage}` : `${h.survivors} won 10,000x`}
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
