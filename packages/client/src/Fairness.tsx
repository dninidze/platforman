import { useEffect, useState } from 'react';
import { hashServerSeed, verifyRound, type FairnessRecord, type VerifyResult } from '@p3/shared';
import type { GameState, Revealed } from './net';

interface LoggedRound extends FairnessRecord {
  roundId: string;
  roomId: string;
  jackpotTile: number;
}

interface Outcome {
  roundId: string;
  source: string;
  result: VerifyResult;
  /** Hash shown in this browser before the round matches the revealed seed. */
  seenHashOk: boolean | null;
  /** Tiles this browser saw go are a prefix of the derived sequences. */
  observedOk: boolean | null;
  serverSeed: string;
  clientSeed: string;
}

const prefixOk = (derived: number[][], observed: number[][]) =>
  observed.every((o, i) => o.every((t, j) => derived[i][j] === t));

/** Recomputes the hash and all three sequences with the same shared library the server uses. */
export function FairnessModal({ s, onClose }: { s: GameState; onClose: () => void }) {
  const [rounds, setRounds] = useState<{ roundId: string }[]>([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    fetch(`/api/rounds?limit=30${s.watching ? `&roomId=${encodeURIComponent(s.watching)}` : ''}`)
      .then((r) => r.json())
      .then((rows: { roundId: string }[]) => {
        setRounds(rows);
        if (!pick && rows[0]) setPick(rows[0].roundId);
      })
      .catch(() => setRounds(s.revealed.map((r) => ({ roundId: r.roundId }))));
  }, [s.watching]); // eslint-disable-line react-hooks/exhaustive-deps

  async function verify(roundId: string) {
    setBusy(true);
    setError(null);
    setOutcome(null);
    const local: Revealed | undefined = s.revealed.find((r) => r.roundId === roundId);
    try {
      let rec: LoggedRound | null = null;
      let source = 'server round log';
      const res = await fetch(`/api/rounds/${encodeURIComponent(roundId)}`);
      if (res.ok) rec = (await res.json()) as LoggedRound;
      else if (local) {
        rec = { ...local, roomId: local.roomId };
        source = 'roundEnd message';
      }
      if (!rec) throw new Error('Round not found in the log');
      const result = verifyRound(rec);
      setOutcome({
        roundId,
        source,
        result,
        seenHashOk: local ? local.hashSeen === hashServerSeed(rec.serverSeed) : null,
        observedOk: local ? prefixOk(result.derived, local.observed) : null,
        serverSeed: rec.serverSeed,
        clientSeed: rec.clientSeed,
      });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const options = [...new Set([...s.revealed.map((r) => r.roundId), ...rounds.map((r) => r.roundId)])];

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="fair-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2 id="fair-title">Provably fair</h2>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="muted small">
          Before each round the server commits to <code>SHA256(serverSeed)</code>. The three tile orders come from
          HMAC-SHA256(serverSeed, clientSeed:stage:counter) with a Fisher–Yates shuffle. The seed is revealed when the round ends,
          so you can recompute every removal.
        </p>
        <div className="kv">
          <span>Current round</span>
          <code>{s.round?.roundId}</code>
          <span>Server seed hash</span>
          <code className="wrap">{s.round?.serverSeedHash}</code>
          <span>Client seed</span>
          <code>{s.round?.clientSeed}</code>
          <span>Server seed</span>
          <code className="muted">revealed when the round ends</code>
        </div>
        <div className="verify-row">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Round to verify">
            {options.length === 0 && <option value="">No finished rounds yet</option>}
            {options.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!pick || busy} onClick={() => verify(pick)}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </div>
        {error && <div className="verdict bad">{error}</div>}
        {outcome && (
          <div aria-live="polite">
            <div className={`verdict ${outcome.result.ok && outcome.seenHashOk !== false && outcome.observedOk !== false ? 'good' : 'bad'}`}>
              {outcome.result.ok && outcome.seenHashOk !== false && outcome.observedOk !== false ? '✔ Verified' : '✘ Mismatch'} – {outcome.roundId}
            </div>
            <ul className="checks">
              <li>{mark(outcome.result.hashOk)} SHA256(serverSeed) equals the published hash</li>
              {outcome.seenHashOk !== null && <li>{mark(outcome.seenHashOk)} …and equals the hash this browser was shown before the round</li>}
              {outcome.result.sequencesOk.map((ok, i) => (
                <li key={i}>
                  {mark(ok)} Platform {i + 1} sequence recomputed ({outcome.result.derived[i].length} tiles)
                </li>
              ))}
              {outcome.result.playedOk.map((ok, i) => (
                <li key={`p${i}`}>
                  {mark(ok)} Platform {i + 1} tiles played follow the sequence
                </li>
              ))}
              {outcome.observedOk !== null && <li>{mark(outcome.observedOk)} Tiles this browser saw go match the sequence</li>}
            </ul>
            <div className="kv">
              <span>Source</span>
              <span>{outcome.source}</span>
              <span>Server seed</span>
              <code className="wrap">{outcome.serverSeed}</code>
              <span>Client seed</span>
              <code>{outcome.clientSeed}</code>
              <span>10,000x tile</span>
              <span>#{[...Array(100).keys()].find((t) => !outcome.result.derived[2].includes(t))! + 1}</span>
            </div>
            <details>
              <summary>Recomputed sequences</summary>
              {outcome.result.derived.map((seq, i) => (
                <p key={i} className="seq">
                  <b>P{i + 1}:</b> {seq.map((t) => t + 1).join(' ')}
                </p>
              ))}
            </details>
          </div>
        )}
      </div>
    </div>
  );
}

const mark = (ok: boolean) => <span className={ok ? 'ok' : 'bad'}>{ok ? '✔' : '✘'}</span>;
