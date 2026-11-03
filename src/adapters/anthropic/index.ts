import type { BatchModel } from '../../kernel/backends.js';
import type { Account, QuotaPartition } from '../../kernel/quota.js';
import type { EnvRef } from '../../kernel/refs.js';
import { AiSdkModelDriver, type AiSdkModelDriverOptions, DEFAULT_INACTIVITY_TIMEOUT_MS } from '../ai-sdk-driver.js';

export { DEFAULT_INACTIVITY_TIMEOUT_MS };
export type AnthropicDriverOptions = AiSdkModelDriverOptions;

/** The Anthropic API through the AI SDK preset, with the Message Batches API behind `submitBatch`. */
export class AnthropicDriver extends AiSdkModelDriver<'anthropic'> {
  public constructor(options: AnthropicDriverOptions = {}) {
    super('anthropic', 'anthropic', options);
  }
}

export const anthropic = {
  /** An Anthropic API key, drawing on the named quota partition. */
  account(name: string, options: { readonly apiKey: EnvRef; readonly quota: QuotaPartition }): Account<'anthropic'> {
    return { entity: 'account', name, driver: 'anthropic', credential: options.apiKey, quota: options.quota };
  },
  model(name: string, options: { readonly id: string }): BatchModel<'anthropic'> {
    return { entity: 'model', name, id: options.id, driver: 'anthropic', batch: true };
  },
  driver(options?: AnthropicDriverOptions): AnthropicDriver {
    return new AnthropicDriver(options);
  },
};
