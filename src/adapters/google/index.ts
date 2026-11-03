import type { BatchModel } from '../../kernel/backends.js';
import type { Account, QuotaPartition } from '../../kernel/quota.js';
import type { EnvRef } from '../../kernel/refs.js';
import { AiSdkModelDriver, type AiSdkModelDriverOptions } from '../ai-sdk-driver.js';

export type GoogleDriverOptions = AiSdkModelDriverOptions;

/** The Gemini API through the AI SDK preset, with batch mode behind `submitBatch`. */
export class GoogleDriver extends AiSdkModelDriver<'google'> {
  public constructor(options: GoogleDriverOptions = {}) {
    super('google', 'google', options);
  }
}

export const google = {
  /** A Gemini API key, drawing on the named quota partition. */
  account(name: string, options: { readonly apiKey: EnvRef; readonly quota: QuotaPartition }): Account<'google'> {
    return { entity: 'account', name, driver: 'google', credential: options.apiKey, quota: options.quota };
  },
  model(name: string, options: { readonly id: string }): BatchModel<'google'> {
    return { entity: 'model', name, id: options.id, driver: 'google', batch: true };
  },
  driver(options?: GoogleDriverOptions): GoogleDriver {
    return new GoogleDriver(options);
  },
};
