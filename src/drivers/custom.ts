import type {
  BatchAdapter,
  Driver,
  DriverInvokeRequest,
  DriverInvokeResult,
  QuotaPatch,
} from '../types.js';

export interface CustomDriverOptions {
  readonly invoke: (req: DriverInvokeRequest) => Promise<DriverInvokeResult>;
  readonly probeQuota?: (accountId: string) => Promise<QuotaPatch>;
  readonly batch?: BatchAdapter;
}

export class CustomDriver implements Driver {
  public readonly kind = 'custom' as const;
  private readonly invokeFn: (req: DriverInvokeRequest) => Promise<DriverInvokeResult>;
  public readonly probeQuota?: (accountId: string) => Promise<QuotaPatch>;
  public readonly batch?: BatchAdapter;

  public constructor(opts: CustomDriverOptions) {
    this.invokeFn = opts.invoke;
    this.probeQuota = opts.probeQuota;
    this.batch = opts.batch;
  }

  public async invoke(req: DriverInvokeRequest): Promise<DriverInvokeResult> {
    return this.invokeFn(req);
  }
}
