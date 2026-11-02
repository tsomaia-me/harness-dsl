import type { Account } from '../kernel/quota.js';
import type { Named } from '../kernel/refs.js';
import type { AccountPolicyDef } from './policies.js';

export class PoolDef<D extends string = string> implements Named {
  public readonly entity = 'pool' as const;
  public readonly name: string;
  public readonly accountList: readonly Account<D>[];
  public readonly drainPolicy: AccountPolicyDef | undefined;
  public readonly fallbackAccount: Account<D> | undefined;
  public readonly _driver?: D;

  public constructor(name: string, accountList: readonly Account<D>[] = [], drainPolicy?: AccountPolicyDef, fallbackAccount?: Account<D>) {
    this.name = name;
    this.accountList = accountList;
    this.drainPolicy = drainPolicy;
    this.fallbackAccount = fallbackAccount;
  }

  public accounts<D2 extends string>(...accounts: readonly Account<D2>[]): PoolDef<D2> {
    return new PoolDef<D2>(this.name, accounts, this.drainPolicy);
  }

  public drain(drainPolicy: AccountPolicyDef): PoolDef<D> {
    return new PoolDef<D>(this.name, this.accountList, drainPolicy, this.fallbackAccount);
  }

  public fallback(account: Account<D>): PoolDef<D> {
    return new PoolDef<D>(this.name, this.accountList, this.drainPolicy, account);
  }
}

export function pool(name: string): PoolDef<string> {
  return new PoolDef(name);
}
