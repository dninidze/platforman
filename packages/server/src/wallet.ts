/** Money is always integer minor units (cents). */
export type Money = number;

export type WalletResult =
  | { ok: true; balance: Money; duplicate?: boolean }
  | { ok: false; error: 'INSUFFICIENT_FUNDS' | 'UNKNOWN_TX' | 'INVALID' | 'UNAVAILABLE'; balance?: Money };

/** Operator wallet seam. debit/credit are idempotent on txId. */
export interface Wallet {
  getBalance(playerId: string, currency: string): Promise<Money>;
  debit(playerId: string, amount: Money, txId: string, roundId: string): Promise<WalletResult>;
  credit(playerId: string, amount: Money, txId: string, roundId: string): Promise<WalletResult>;
  rollback(txId: string): Promise<WalletResult>;
}

export interface LedgerEntry {
  txId: string;
  playerId: string;
  roundId: string;
  kind: 'debit' | 'credit' | 'rollback';
  amount: Money;
  balanceAfter: Money;
}

/** In-memory play-money wallet. Each new player gets `startingBalance` demo credits. */
export class MockWallet implements Wallet {
  private readonly balances = new Map<string, Money>();
  private readonly txs = new Map<string, { entry: LedgerEntry; result: { ok: true; balance: Money }; rolledBack: boolean }>();
  readonly ledger: LedgerEntry[] = [];
  /** Test hook: fail the next N credits with UNAVAILABLE. */
  failNextCredits = 0;

  constructor(
    private readonly startingBalance: Money,
    readonly currency = 'EUR',
  ) {}

  private bal(playerId: string): Money {
    let b = this.balances.get(playerId);
    if (b === undefined) {
      b = this.startingBalance;
      this.balances.set(playerId, b);
    }
    return b;
  }

  /** Synchronous peek used for snapshots; the async interface is the contract. */
  peekBalance(playerId: string): Money {
    return this.bal(playerId);
  }

  async getBalance(playerId: string, _currency?: string): Promise<Money> {
    return this.bal(playerId);
  }

  async debit(playerId: string, amount: Money, txId: string, roundId: string): Promise<WalletResult> {
    const prev = this.txs.get(txId);
    if (prev) return prev.entry.kind === 'debit' ? { ...prev.result, duplicate: true } : { ok: false, error: 'INVALID' };
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false, error: 'INVALID' };
    const b = this.bal(playerId);
    if (b < amount) return { ok: false, error: 'INSUFFICIENT_FUNDS', balance: b };
    return this.record(playerId, txId, roundId, 'debit', amount, b - amount);
  }

  async credit(playerId: string, amount: Money, txId: string, roundId: string): Promise<WalletResult> {
    const prev = this.txs.get(txId);
    if (prev) return prev.entry.kind === 'credit' ? { ...prev.result, duplicate: true } : { ok: false, error: 'INVALID' };
    if (this.failNextCredits > 0) {
      this.failNextCredits--;
      return { ok: false, error: 'UNAVAILABLE' };
    }
    if (!Number.isInteger(amount) || amount < 0) return { ok: false, error: 'INVALID' };
    return this.record(playerId, txId, roundId, 'credit', amount, this.bal(playerId) + amount);
  }

  async rollback(txId: string): Promise<WalletResult> {
    const tx = this.txs.get(txId);
    if (!tx) return { ok: false, error: 'UNKNOWN_TX' };
    const { playerId, amount, kind, roundId } = tx.entry;
    if (tx.rolledBack) return { ok: true, balance: this.bal(playerId), duplicate: true };
    tx.rolledBack = true;
    const balance = this.bal(playerId) + (kind === 'debit' ? amount : -amount);
    this.balances.set(playerId, balance);
    this.ledger.push({ txId: `${txId}:rollback`, playerId, roundId, kind: 'rollback', amount, balanceAfter: balance });
    return { ok: true, balance };
  }

  private record(playerId: string, txId: string, roundId: string, kind: 'debit' | 'credit', amount: Money, balance: Money): WalletResult {
    this.balances.set(playerId, balance);
    const entry: LedgerEntry = { txId, playerId, roundId, kind, amount, balanceAfter: balance };
    this.ledger.push(entry);
    const result = { ok: true as const, balance };
    this.txs.set(txId, { entry, result, rolledBack: false });
    return result;
  }
}
