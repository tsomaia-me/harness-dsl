import { describe, expect, it } from 'vitest';
import { validate } from '../../src/dsl/index.js';
import { codingTeam, flows, lanes } from './scenarios/01-coding-team.js';

describe('scenario 01, the coding team, in the 0.4.0 DSL', () => {
  it('validates clean', () => {
    expect(validate(codingTeam)).toEqual([]);
  });

  it('declares the tree with named nodes and the lane maps every exit', () => {
    expect(flows.buildAudit.nodes.map((node) => `${node.type}:${node.name}`)).toEqual(['loop:rounds', 'exit:done', 'exit:incomplete']);
    const loop = flows.buildAudit.nodes[0]!;
    if (loop.type !== 'loop') throw new Error('expected a loop');
    expect(loop.nodes.map((node) => node.name)).toEqual(['build', 'audit']);
    expect(loop.carry).toBeDefined();
    expect(Object.keys(lanes.bugLane.handlerDef!.exits)).toEqual(['done', 'incomplete']);
    expect(lanes.bugLane.handlerDef!.params).toEqual({ rounds: 3 });
    expect(lanes.featureLane.handlerDef!.params).toEqual({ rounds: 5 });
    expect(flows.epicFlow.nodes.map((node) => node.type)).toEqual(['step', 'spawn', 'exit', 'exit']);
  });

  it('registers four lanes in one scheduler class each, three shares and one trigger', () => {
    expect(codingTeam.laneList.map((lane) => lane.name)).toEqual(['heartbeats', 'bugs', 'features', 'epics']);
    expect(codingTeam.schedulerDef!.standards.map((lane) => lane.name)).toEqual(['heartbeats', 'bugs', 'features', 'epics']);
    expect(codingTeam.shares.map((share) => `${share.account.name}=${share.fraction}`)).toEqual(['claude-max-a=0.6', 'claude-max-b=0.6', 'claude-max-c=0.3']);
    expect(codingTeam.triggerList).toHaveLength(1);
    expect(codingTeam.triggerList[0]!.source!.spec).toMatchObject({ on: 'transition', to: [{ name: 'Unhealthy' }] });
  });
});
