import {
  AiSdkDriver,
  type AiSdkDriverOptions,
  type ProviderConnection,
  type ProviderOptions,
  type ProviderPreset,
} from './ai-sdk.js';
import { ClaudeCliDriver, type ClaudeCliDriverOptions } from './claude-cli.js';
import { CustomDriver, type CustomDriverOptions } from './custom.js';
import { MockDriver, type MockDriverOptions } from './mock.js';

export {
  AiSdkDriver,
  type AiSdkDriverOptions,
  ClaudeCliDriver,
  type ProviderConnection,
  type ProviderOptions,
  type ProviderPreset,
  type ClaudeCliDriverOptions,
  CustomDriver,
  type CustomDriverOptions,
  MockDriver,
  type MockDriverOptions,
};

export const drivers = {
  claudeCli(opts?: ClaudeCliDriverOptions): ClaudeCliDriver {
    return new ClaudeCliDriver(opts);
  },
  aiSdk(opts: AiSdkDriverOptions): AiSdkDriver {
    return new AiSdkDriver(opts);
  },
  custom(opts: CustomDriverOptions): CustomDriver {
    return new CustomDriver(opts);
  },
  mock(opts?: MockDriverOptions): MockDriver {
    return new MockDriver(opts);
  },
};
