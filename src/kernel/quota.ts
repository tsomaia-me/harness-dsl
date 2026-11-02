import type { EnvRef, Named } from './refs.js';

export type QuotaEvent =
  | { readonly type: 'consumed'; readonly account: string; readonly harness: string; readonly tokens: number; readonly costUsd: number; readonly at: Date }
  | { readonly type: 'cooldown'; readonly account: string; readonly harness: string; readonly until: Date; readonly reason: string; readonly at: Date }
  | { readonly type: 'windowObserved'; readonly account: string; readonly harness: string; readonly window: string; readonly utilization: number; readonly resetsAt: Date | null; readonly at: Date };

export interface ObservedWindow {
  readonly window: string;
  readonly utilization: number;
  readonly resetsAt: Date | null;
}

export type Refusal = 'rateLimited' | 'unavailable';

export class AccountRefusedError extends Error {
  public readonly account: string;
  public readonly refusal: Refusal;
  public readonly until: Date;
  public readonly windows: readonly ObservedWindow[];

  public constructor(account: string, refusal: Refusal, until: Date, detail: string, windows: readonly ObservedWindow[] = []) {
    super(`account "${account}" refused the call (${refusal}) until ${until.toISOString()}: ${detail}`);
    this.name = 'AccountRefusedError';
    this.account = account;
    this.refusal = refusal;
    this.until = until;
    this.windows = windows;
  }
}

export interface QuotaPartition extends Named {
  join(harness: string, holder: string, ttlMs: number): Promise<{ readonly accepted: boolean; readonly heldBy?: string }>;
  append(events: readonly QuotaEvent[]): Promise<void>;
  read(query: { readonly accounts: readonly string[]; readonly since: Date }): AsyncIterable<QuotaEvent>;
  close(): void;
}

export interface Account<D extends string = string> extends Named {
  readonly entity: 'account';
  readonly driver: D;
  readonly credential: EnvRef;
  readonly quota: QuotaPartition;
}

export interface AccountState {
  readonly account: Account;
  readonly utilization: number;
  readonly shareUsed: number;
  readonly shareCap: number;
  readonly windowResetsAt: Date | null;
  readonly cooldownUntil?: Date;
}
