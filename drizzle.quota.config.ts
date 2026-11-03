import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/adapters/sqlite/quota-schema.ts',
  out: './drizzle-quota',
});
