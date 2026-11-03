import type { BatchModel } from '../../kernel/backends.js';
import type { Account, QuotaPartition } from '../../kernel/quota.js';
import type { EnvRef } from '../../kernel/refs.js';
import { openrouterPreset } from '../../presets/openrouter.js';
import { AiSdkModelDriver, type AiSdkModelDriverOptions } from '../ai-sdk-driver.js';

export type OpenRouterDriverOptions = AiSdkModelDriverOptions;

/** OpenRouter through its OpenAI-compatible API, with its batch endpoint behind `submitBatch`. Model ids are `<vendor>/<model>`. */
export class OpenRouterDriver extends AiSdkModelDriver<'openrouter'> {
  public constructor(options: OpenRouterDriverOptions = {}) {
    super('openrouter', openrouterPreset, options);
  }
}

export const openrouter = {
  /** An OpenRouter API key, drawing on the named quota partition. */
  account(name: string, options: { readonly apiKey: EnvRef; readonly quota: QuotaPartition }): Account<'openrouter'> {
    return { entity: 'account', name, driver: 'openrouter', credential: options.apiKey, quota: options.quota };
  },
  model(name: string, options: { readonly id: string }): BatchModel<'openrouter'> {
    return { entity: 'model', name, id: options.id, driver: 'openrouter', batch: true };
  },
  driver(options?: OpenRouterDriverOptions): OpenRouterDriver {
    return new OpenRouterDriver(options);
  },
};
