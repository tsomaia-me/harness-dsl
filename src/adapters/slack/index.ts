import type { Metrics, Observer, SequencedEvent, UnitRecord } from '../../kernel/index.js';
import type { EnvRef, Resolver } from '../../kernel/refs.js';

export interface SlackObserverOptions {
  /** An incoming-webhook URL. */
  readonly webhook: EnvRef;
  readonly fetch?: typeof fetch;
}

type Query = { unit(id: string): Promise<UnitRecord | undefined>; readonly metrics: Metrics; readonly resolver: Resolver };

/** Posts what needs a human to a Slack channel: questions asked, attempts stuck on a failure or budget, lanes paused. */
export class SlackObserver implements Observer {
  public readonly entity = 'observer' as const;
  public readonly name: string;
  private readonly unitsByAttempt = new Map<string, string>();

  public constructor(
    name: string,
    private readonly options: SlackObserverOptions,
  ) {
    this.name = name;
  }

  private async post(query: Query, text: string): Promise<void> {
    const send = this.options.fetch ?? globalThis.fetch;
    const response = await send(query.resolver.env(this.options.webhook), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error(`Slack answered ${response.status}`);
  }

  public async observe(entry: SequencedEvent, query: Query): Promise<void> {
    const event = entry.event;
    if (event.type === 'attemptStarted') this.unitsByAttempt.set(event.attemptId, event.unitId);
    if (event.type === 'attemptBlocked' && (event.on === 'decision' || event.on === 'stepFailure' || event.on === 'budget')) {
      const unitId = this.unitsByAttempt.get(event.attemptId);
      const record = unitId ? await query.unit(unitId) : undefined;
      const where = record ? `${record.unit.lane}/${record.unit.key}` : event.attemptId;
      const what = event.on === 'decision' ? `asks: ${event.ask ?? event.halt ?? 'a decision'}` : `is stuck on ${event.on}: ${event.detail ?? ''}`;
      await this.post(query, `${where} ${what}`);
    }
    if (event.type === 'lanePaused') await this.post(query, `lane ${event.lane} paused by ${event.by}: ${event.reason}`);
  }
}

export const slack = {
  observer(name: string, options: SlackObserverOptions): SlackObserver {
    return new SlackObserver(name, options);
  },
};
