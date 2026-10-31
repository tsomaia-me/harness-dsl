import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { FlowEngine, H, HarnessStore, z } from '../../src/index.js';

describe('DSL Compile-Time and Runtime Type Propagation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('propagates strongly-typed step outputs across .step(), .when(), .branch(), .parallel(), .loop(), and .batch()', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'harness-types-'));
    tempDirs.push(dir);
    const store = new HarnessStore(dir);
    const engine = new FlowEngine(store);

    const PlanSchema = z.object({
      files: z.array(z.string()),
      risk: z.enum(['low', 'high']),
    });
    const CodeSchema = z.object({
      changedCount: z.number(),
    });
    const ReviewSchema = z.object({
      approved: z.boolean(),
    });
    const FastRouteSchema = z.object({
      fastLane: z.boolean(),
    });
    const DeepRouteSchema = z.object({
      deepAudit: z.number(),
    });
    const BatchOutSchema = z.object({
      checkedFile: z.string(),
    });

    const PlanCmd = H.command('plan')
      .input(z.object({ prompt: z.string() }))
      .output(PlanSchema)
      .run(async ({ input }) => ({
        files: [input.prompt],
        risk: 'low' as const,
      }));

    const CodeCmd = H.command('code')
      .input(PlanSchema)
      .output(CodeSchema)
      .run(async ({ input }) => ({
        changedCount: input.files.length,
      }));

    const ExtraReviewCmd = H.command('extra-review')
      .input(CodeSchema)
      .output(ReviewSchema)
      .run(async ({ input }) => ({
        approved: input.changedCount > 0,
      }));

    const FastRouteCmd = H.command('fast-route')
      .input(z.any())
      .output(FastRouteSchema)
      .run(async () => ({ fastLane: true }));

    const DeepRouteCmd = H.command('deep-route')
      .input(z.any())
      .output(DeepRouteSchema)
      .run(async () => ({ deepAudit: 100 }));

    const CheckFileCmd = H.command('check-file')
      .input(z.string())
      .output(BatchOutSchema)
      .run(async ({ input }) => ({ checkedFile: input }));

    const flow = H.flow('typed-pipeline')
      .input(z.object({ prompt: z.string() }))
      .step('plan', PlanCmd, (ctx) => ({ prompt: ctx.input.prompt }))
      .when(
        (ctx) => ctx.steps.plan.risk === 'low',
        (sub) => sub.step('optReview', ExtraReviewCmd, (ctx) => ({ changedCount: ctx.steps.plan.files.length })),
      )
      .branch((ctx) => (ctx.steps.plan.risk === 'low' ? 'fast' : 'deep'), {
        fast: FastRouteCmd,
        deep: (sub) => sub.step('deepStep', DeepRouteCmd),
      })
      .parallel({
        code: {
          executable: CodeCmd,
          mapInput: (ctx) => ctx.steps.plan,
        },
        condReview: H.when(
          (ctx) => ctx.steps.plan.files.length > 0,
          ExtraReviewCmd,
          (ctx) => ({ changedCount: ctx.steps.plan.files.length }),
        ),
      })
      .loop({
        maxIterations: 2,
        body: (round) =>
          round.step('loopVerify', ExtraReviewCmd, (ctx) => {
            expectTypeOf(ctx.steps.code).toEqualTypeOf<{ changedCount: number }>();
            return ctx.steps.code;
          }),
        until: (ctx) => {
          expectTypeOf(ctx.steps.loopVerify).toEqualTypeOf<{ approved: boolean }>();
          return ctx.steps.loopVerify.approved;
        },
      })
      .batch('fileChecks', {
        items: (ctx) => ctx.steps.plan.files,
        execute: CheckFileCmd,
      });

    const res = await engine.run(flow, { prompt: 'src/index.ts' });

    expectTypeOf(res.steps.plan).toEqualTypeOf<{ files: string[]; risk: 'low' | 'high' }>();
    expectTypeOf(res.steps.optReview).toEqualTypeOf<{ approved: boolean } | undefined>();
    expectTypeOf(res.steps.fast).toEqualTypeOf<{ fastLane: boolean } | undefined>();
    expectTypeOf(res.steps.deepStep).toEqualTypeOf<{ deepAudit: number } | undefined>();
    expectTypeOf(res.steps.code).toEqualTypeOf<{ changedCount: number }>();
    expectTypeOf(res.steps.condReview).toEqualTypeOf<{ approved: boolean } | undefined>();
    expectTypeOf(res.steps.loopVerify).toEqualTypeOf<{ approved: boolean }>();
    expectTypeOf(res.steps.fileChecks).toEqualTypeOf<{ checkedFile: string }[]>();

    expect.soft(res.steps.code.changedCount).toBe(1);
    expect.soft(res.steps.optReview).toEqual({ approved: true });
    expect.soft(res.steps.fast).toEqual({ fastLane: true });
    expect.soft(res.steps.condReview).toEqual({ approved: true });
    expect.soft(res.steps.loopVerify).toEqual({ approved: true });
    expect.soft(res.steps.fileChecks).toEqual([{ checkedFile: 'src/index.ts' }]);
    store.close();
  });
});
