import type {
  BatchAdapter,
  Driver,
  DriverInvokeRequest,
  DriverInvokeResult,
  HookProtocol,
  QuotaPatch,
  QuotaPolicy,
} from '../types.js';

export interface CustomDriverOptions {
  readonly invoke: (req: DriverInvokeRequest) => Promise<DriverInvokeResult>;
  readonly probeQuota?: (accountId: string) => Promise<QuotaPatch>;
  readonly batch?: BatchAdapter;
  readonly quotaPolicy?: Partial<QuotaPolicy>;
  readonly hookProtocol?: HookProtocol;
}

export class CustomDriver implements Driver {
  public readonly kind = 'custom';
  private readonly invokeFn: (req: DriverInvokeRequest) => Promise<DriverInvokeResult>;
  public readonly probeQuota?: (accountId: string) => Promise<QuotaPatch>;
  public readonly batch?: BatchAdapter;
  public readonly quotaPolicy?: Partial<QuotaPolicy>;
  public readonly hookProtocol?: HookProtocol;

  public constructor(opts: CustomDriverOptions) {
    this.invokeFn = opts.invoke;
    this.probeQuota = opts.probeQuota;
    this.batch = opts.batch;
    this.quotaPolicy = opts.quotaPolicy;
    this.hookProtocol = opts.hookProtocol;
  }

  public async invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult> {
    return this.invokeFn(req);
  }
}
