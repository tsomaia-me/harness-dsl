import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Metrics, Observer, SequencedEvent, UnitRecord } from '../../kernel/index.js';

type Query = { unit(id: string): Promise<UnitRecord | undefined>; readonly metrics: Metrics };

function cell(value: string | undefined): string {
  return (value ?? '—').replace(/\|/g, '/').replace(/\n/g, ' ');
}

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
}

/** `BOARD.md`: every unit per lane with its state, position, open attempt and the question it waits on. */
export class MarkdownBoard implements Observer {
  public readonly entity = 'observer' as const;
  public readonly name: string;
  private readonly file: string;
  private readonly units = new Map<string, string>();
  private readonly asks = new Map<string, string>();
  private readonly paused = new Map<string, string>();

  public constructor(name: string, options: { readonly path: string }) {
    this.name = name;
    this.file = path.resolve(options.path);
  }

  public async observe(entry: SequencedEvent, query: Query): Promise<void> {
    const event = entry.event;
    if (event.type === 'unitCreated') this.units.set(event.unitId, event.lane);
    if (event.type === 'attemptBlocked') this.asks.set(event.attemptId, event.ask ?? event.detail ?? event.on);
    if (event.type === 'attemptEnded') this.asks.delete(event.attemptId);
    if (event.type === 'lanePaused') this.paused.set(event.lane, event.reason);
    if (event.type === 'laneResumed') this.paused.delete(event.lane);
    const rows = new Map<string, string[]>();
    for (const [unitId, lane] of this.units) {
      const record = await query.unit(unitId);
      if (!record) continue;
      const attempt = record.unit.attempt;
      const row = `| ${cell(record.unit.key)} | ${cell(record.unit.state)} | ${cell(record.unit.position)} | ${cell(attempt ? (attempt.halt ?? attempt.step) : undefined)} | ${cell(attempt ? this.asks.get(attempt.id) : undefined)} |`;
      rows.set(lane, [...(rows.get(lane) ?? []), row]);
    }
    const sections = [...rows.entries()].map(([lane, laneRows]) => ['', `## ${lane}${this.paused.has(lane) ? ` (paused: ${this.paused.get(lane)})` : ''}`, '', '| Key | State | Position | Attempt | Waiting on |', '| :-- | :-- | :-- | :-- | :-- |', ...laneRows].join('\n'));
    write(this.file, ['# Board', '', `_as of ${event.at.toISOString()}, event ${entry.seq}_`, ...sections, ''].join('\n'));
  }
}

/** `TELEMETRY.md`: attempts per lane and per seat and model from the metrics, and the cost folded from invocations. */
export class MarkdownTelemetry implements Observer {
  public readonly entity = 'observer' as const;
  public readonly name: string;
  private readonly file: string;
  private readonly lanes = new Set<string>();
  private readonly seats = new Map<string, Set<string>>();
  private invocations = 0;
  private costUsd = 0;
  private tokens = 0;

  public constructor(name: string, options: { readonly path: string }) {
    this.name = name;
    this.file = path.resolve(options.path);
  }

  public async observe(entry: SequencedEvent, query: Query): Promise<void> {
    const event = entry.event;
    if (event.type === 'unitCreated') this.lanes.add(event.lane);
    if (event.type === 'invocation') {
      this.invocations += 1;
      this.costUsd += event.costUsd;
      this.tokens += event.tokens ?? 0;
      if (event.seat && event.model) this.seats.set(event.seat, new Set([...(this.seats.get(event.seat) ?? []), event.model]));
    }
    const percent = (rate: number) => `${Math.round(rate * 100)}%`;
    const laneRows = [...this.lanes].map((lane) => {
      const attempts = query.metrics.attempts({ of: { entity: 'lane', name: lane } });
      const outcomes = query.metrics.outcomes({ of: { entity: 'lane', name: lane } });
      return `| ${lane} | ${attempts.samples} | ${attempts.succeeded} | ${attempts.failed} | ${percent(attempts.successRate)} | ${outcomes.terminal} | ${percent(outcomes.successRate)} |`;
    });
    const seatRows = [...this.seats.entries()].flatMap(([seat, models]) =>
      [...models].map((model) => {
        const totals = { samples: 0, succeeded: 0, failed: 0 };
        for (const lane of this.lanes) {
          const counts = query.metrics.attempts({ of: { entity: 'lane', name: lane }, seat: { entity: 'seat', name: seat }, model: { name: model } });
          totals.samples += counts.samples;
          totals.succeeded += counts.succeeded;
          totals.failed += counts.failed;
        }
        return `| ${seat} | ${model} | ${totals.samples} | ${totals.succeeded} | ${totals.failed} |`;
      }),
    );
    write(
      this.file,
      [
        '# Telemetry',
        '',
        `_as of ${event.at.toISOString()}, event ${entry.seq}_`,
        '',
        '## Lanes',
        '',
        '| Lane | Attempts | Succeeded | Failed | Attempt success | Terminal | Outcome success |',
        '| :-- | --: | --: | --: | --: | --: | --: |',
        ...laneRows,
        '',
        '## Seats',
        '',
        '| Seat | Model | Attempts | Succeeded | Failed |',
        '| :-- | :-- | --: | --: | --: |',
        ...seatRows,
        '',
        '## Cost',
        '',
        `- Total: $${this.costUsd.toFixed(2)} over ${this.invocations} invocations and ${this.tokens} tokens`,
        '',
      ].join('\n'),
    );
  }
}

export const markdown = {
  board(name: string, options: { readonly path: string }): MarkdownBoard {
    return new MarkdownBoard(name, options);
  },
  telemetry(name: string, options: { readonly path: string }): MarkdownTelemetry {
    return new MarkdownTelemetry(name, options);
  },
};
