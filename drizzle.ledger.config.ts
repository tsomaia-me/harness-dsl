import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/adapters/sqlite/ledger-schema.ts',
  out: './drizzle-ledger',
});
