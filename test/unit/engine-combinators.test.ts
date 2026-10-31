import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FlowEngine, H, HarnessStore, z } from '../../src/index.js';

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('FlowEngine Combinators & Userland Arbitration Composition', () => {
  const tempDirs: string[] = [];

  function makeEngine(): { store: HarnessStore; engine: FlowEngine } {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-engine-test-'));
    tempDirs.push(dir);
    const store = new HarnessStore(dir);
    return { store, engine: new FlowEngine(store) };
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('executes complete Builder -> Dispute Arbiter -> Auditor userland loop with haltIf resume and no state bleed across iterations', async () => {
    const { store, engine } = makeEngine();

    const CriterionSchema = z.object({ id: z.string(), text: z.string() });
    const DisputeSchema = z.object({
      criterionId: z.string(),
      citation: z.string(),
      reason: z.string(),
    });
    const TicketSchema = z.object({
      id: z.string(),
      criteria: z.array(CriterionSchema),
    });

    const BuildSkill = H.skill('build')
      .input(
        z.object({
          ticket: TicketSchema,
          priorDeficits: z.array(CriterionSchema),
          lockedIds: z.array(z.string()),
        }),
      )
      .output(
        z.object({
          status: z.enum(['READY', 'NEEDS_OWNER']),
          question: z.string().optional(),
          touchedUi: z.boolean(),
          disputes: z.array(DisputeSchema),
        }),
      );

    const ArbitrateSkill = H.skill('arbitrate')
      .input(
        z.object({
          disputes: z.array(DisputeSchema),
          deficits: z.array(CriterionSchema),
        }),
      )
      .output(
        z.object({
          overruledIds: z.array(z.string()),
          rejectedIds: z.array(z.string()),
          contradiction: z.string().optional(),
        }),
      );

    const AuditSkill = H.skill('audit')
      .input(
        z.object({
          ticket: TicketSchema,
          overruledIds: z.array(z.string()),
        }),
      )
      .output(
        z.object({
          deficits: z.array(CriterionSchema),
          breakOncePassed: z.boolean(),
        }),
      );

    const VisualSkill = H.skill('visual')
      .input(z.any())
      .output(z.object({ passed: z.boolean() }));

    let buildRound = 0;
    const builderMock = H.drivers.mock({
      handler: async () => {
        buildRound += 1;
        if (buildRound === 1) {
          return {
            structuredOutput: {
              status: 'NEEDS_OWNER',
              question: 'Should negative balance clamp to zero?',
              touchedUi: false,
              disputes: [
                {
                  criterionId: 'AC-2',
                  citation: 'SPEC.md §3.2',
                  reason: 'Spec states rounding is floor, not round-half-up',
                },
              ],
            },
          };
        }
        return {
          structuredOutput: {
            status: 'READY',
            touchedUi: true,
            disputes: [],
          },
        };
      },
    });

    const arbiterMock = H.drivers.mock({
      responses: [
        {
          structuredOutput: {
            overruledIds: ['AC-2'],
            rejectedIds: [],
          },
        },
      ],
    });

    let auditRound = 0;
    const seenOverruledByRound: string[][] = [];
    const auditorMock = H.drivers.mock({
      handler: async (req) => {
        auditRound += 1;
        const parsedMatch = /"overruledIds":\s*(\[[^\]]*\])/.exec(req.userPrompt);
        seenOverruledByRound.push(parsedMatch ? JSON.parse(parsedMatch[1]!) : []);
        if (auditRound === 1) {
          return {
            structuredOutput: {
              deficits: [{ id: 'AC-2', text: 'Expected round-half-up' }],
              breakOncePassed: true,
            },
          };
        }
        return {
          structuredOutput: {
            deficits: [],
            breakOncePassed: true,
          },
        };
      },
    });

    const visualMock = H.drivers.mock({
      responses: [{ structuredOutput: { passed: true } }],
    });

    const Builder = H.agent('builder').model(H.model(H.account('b', builderMock), 'claude-opus-4-6'));
    const Arbiter = H.agent('arbiter').model(H.model(H.account('j', arbiterMock), 'claude-opus-4-6'));
    const Auditor = H.agent('auditor').model(H.model(H.account('a', auditorMock), 'claude-opus-4-6'));
    const VisualJudge = H.agent('visual').model(
      H.model(H.account('v', visualMock), 'claude-sonnet-4-6'),
    );

    let finallyCalled = false;

    const ticketFlow = H.flow('ticket-flow')
      .input(TicketSchema)
      .loop({
        maxIterations: 3,
        body: (round) =>
          round
            .step(
              'build',
              Builder.run(BuildSkill, (ctx) => ({
                ticket: ctx.input,
                priorDeficits: ctx.prev?.audit?.deficits ?? [],
                lockedIds: ctx.prev?.arbitrate?.rejectedIds ?? [],
              })),
            )
            .haltIf(
              (ctx) => ctx.steps.build.status === 'NEEDS_OWNER',
              (ctx) => ({ reason: ctx.steps.build.question ?? 'Owner input needed' }),
            )
            .when(
              (ctx) => ctx.steps.build.disputes.length > 0,
              (sub) =>
                sub.step(
                  'arbitrate',
                  Arbiter.run(ArbitrateSkill, (ctx) => ({
                    disputes: ctx.steps.build.disputes,
                    deficits: ctx.prev?.audit?.deficits ?? [],
                  })),
                ),
            )
            .parallel({
              audit: Auditor.run(AuditSkill, (ctx) => ({
                ticket: ctx.input,
                overruledIds: ctx.steps.arbitrate?.overruledIds ?? [],
              })),
              visual: H.when(
                (ctx) => Boolean(ctx.steps.build.touchedUi),
                VisualJudge.run(VisualSkill, (ctx) => ctx.input),
              ),
            }),
        until: (ctx) =>
          ctx.steps.audit.deficits.length === 0 &&
          ctx.steps.audit.breakOncePassed &&
          (ctx.steps.visual ? ctx.steps.visual.passed : true),
      })
      .finally(() => {
        finallyCalled = true;
      });

    const runPromise = engine.run(
      ticketFlow,
      {
        id: 'CD-500',
        criteria: [
          { id: 'AC-1', text: 'Clamp balance' },
          { id: 'AC-2', text: 'Floor rounding' },
        ],
      },
      { runId: 'run-arb-1' },
    );

    await waitFor(() => store.getRun('run-arb-1')?.status === 'blocked');
    expect.soft(store.getRun('run-arb-1')?.status).toBe('blocked');
    expect.soft(store.getRun('run-arb-1')?.blockerReason).toBe(
      'Should negative balance clamp to zero?',
    );

    store.resolveBlocker('run-arb-1', { clampToZero: true });
    const result = await runPromise;

    expect.soft(result.status).toBe('completed');
    expect.soft(result.iterations).toBe(2);
    expect.soft(result.resolutions).toEqual([{ clampToZero: true }]);
    expect.soft(arbiterMock.calls.length).toBe(1);
    expect.soft(seenOverruledByRound).toEqual([['AC-2'], []]);
    expect.soft(visualMock.calls.length).toBe(1);
    expect.soft(finallyCalled).toBe(true);
    store.close();
  });

  it.each([
    {
      label: 'takes the ticket id and touched paths from identify()',
      identified: true,
      expected: { ticketId: 'CD-9', touchedPaths: ['apps/edge/**'] },
    },
    {
      label: 'reads nothing from input fields a flow did not name',
      identified: false,
      expected: { ticketId: null, touchedPaths: [] },
    },
  ])('$label', async ({ identified, expected }) => {
    const { store, engine } = makeEngine();
    const TicketInput = z.object({ id: z.string(), key: z.string(), touches: z.array(z.string()), files: z.array(z.string()) });
    const SeePaths = H.command('see-paths')
      .input(z.any())
      .output(z.object({ touchedPaths: z.array(z.string()) }))
      .run(({ ctx }) => ({ touchedPaths: [...ctx.touchedPaths] }));
    const base = H.flow('identity-flow').input(TicketInput);
    const flow = (identified
      ? base.identify({ ticketId: (input) => input.key, touchedPaths: (input) => input.files })
      : base
    ).step('see', SeePaths);

    const result = await engine.run(flow, {
      id: 'sniffed-id',
      key: 'CD-9',
      touches: ['sniffed/**'],
      files: ['apps/edge/**'],
    });
    expect.soft(store.getRun(result.runId)?.ticketId ?? null).toBe(expected.ticketId);
    expect.soft(result.steps.see.touchedPaths).toEqual(expected.touchedPaths);
    store.close();
  });

  it('executes .branch() and .batch() via Cloud Batch API when items.length > 1 and runs skill .assert()', async () => {
    const { store, engine } = makeEngine();

    const ItemSkill = H.skill('analyze-item')
      .input(z.object({ name: z.string() }))
      .output(z.object({ upper: z.string() }))
      .assert((out, inp) => {
        if (out.upper !== inp.name.toUpperCase()) {
          throw new Error('Batch assertion mismatch');
        }
      });

    const cloudBatchMock = H.drivers.mock({
      enableBatch: true,
      handler: async (req) => {
        const match = /"name":\s*"([^"]+)"/.exec(req.userPrompt);
        return {
          structuredOutput: { upper: (match?.[1] ?? '').toUpperCase() },
        };
      },
    });

    const BatchAgent = H.agent('batch-agent').model(
      H.model(H.account('batch-acct', cloudBatchMock), 'claude-sonnet-4-6'),
    );

    const FastCmd = H.command('fast')
      .input(z.any())
      .output(z.object({ route: z.string() }))
      .run(async () => ({ route: 'fast-path' }));

    const SlowCmd = H.command('slow')
      .input(z.any())
      .output(z.object({ route: z.string() }))
      .run(async () => ({ route: 'slow-path' }));

    const flow = H.flow('batch-and-branch')
      .input(z.object({ mode: z.enum(['fast', 'slow']), items: z.array(z.string()) }))
      .branch((ctx) => ctx.input.mode, {
        fast: FastCmd,
        slow: SlowCmd,
      })
      .batch('processed', {
        items: (ctx) => ctx.input.items.map((name) => ({ name })),
        execute: BatchAgent.run(ItemSkill),
      });

    const res = await engine.run(flow, {
      mode: 'fast',
      items: ['alpha', 'beta', 'gamma'],
    });

    expect.soft(res.steps.fast).toEqual({ route: 'fast-path' });
    expect.soft(res.steps.processed).toEqual([
      { upper: 'ALPHA' },
      { upper: 'BETA' },
      { upper: 'GAMMA' },
    ]);
    expect.soft(cloudBatchMock.batchSubmits.length).toBe(1);
    expect.soft(cloudBatchMock.batchSubmits[0]?.length).toBe(3);
    store.close();
  });
});
