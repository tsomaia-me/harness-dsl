import type { QuotaPatch } from '../types.js';

export class RateLimitedError extends Error {
  public readonly accountId: string;
  public readonly quota: QuotaPatch;

  public constructor(accountId: string, message: string, quota: QuotaPatch = {}) {
    super(message);
    this.name = 'RateLimitedError';
    this.accountId = accountId;
    this.quota = quota;
  }
}

export class AccountUnavailableError extends Error {
  public readonly accountId: string;
  public readonly reason: string;

  public constructor(accountId: string, reason: string) {
    super(`Account "${accountId}" is unavailable: ${reason}`);
    this.name = 'AccountUnavailableError';
    this.accountId = accountId;
    this.reason = reason;
  }
}
