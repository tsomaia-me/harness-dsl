import { SqliteLedger, type SqliteLedgerOptions } from './ledger.js';
import { quota, SqliteQuotaPartition } from './quota.js';

export { SqliteLedger, SqliteQuotaPartition };

export const sqlite = {
  ledger(options: SqliteLedgerOptions): SqliteLedger {
    return new SqliteLedger(options);
  },
  quota,
};
