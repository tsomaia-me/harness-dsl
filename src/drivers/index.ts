import {
  AiSdkDriver,
  type AiSdkDriverOptions,
  type ProviderConnection,
  type ProviderOptions,
  type ProviderPreset,
  type SdkProviderName,
} from './ai-sdk.js';
import {
  CLAUDE_SUBSCRIPTION_QUOTA_POLICY,
  ClaudeCliDriver,
  type ClaudeCliDriverOptions,
} from './claude-cli.js';
import { CustomDriver, type CustomDriverOptions } from './custom.js';
import { MockDriver, type MockDriverOptions } from './mock.js';

export {
  AiSdkDriver,
  type AiSdkDriverOptions,
  CLAUDE_SUBSCRIPTION_QUOTA_POLICY,
  ClaudeCliDriver,
  type ClaudeCliDriverOptions,
  CustomDriver,
  type CustomDriverOptions,
  MockDriver,
  type MockDriverOptions,
  type ProviderConnection,
  type ProviderOptions,
  type ProviderPreset,
  type SdkProviderName,
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
