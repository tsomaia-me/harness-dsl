import { createHash } from 'node:crypto';
import type { FlowDef, FlowNode } from '../dsl/flows.js';

export interface Frame {
  readonly name: string;
  readonly iteration?: number;
}

export function address(frames: readonly Frame[]): string {
  return frames.map((frame) => (frame.iteration === undefined ? frame.name : `${frame.name}[${frame.iteration}]`)).join('/');
}

export function topLevelIndex(flow: FlowDef<unknown, unknown, unknown, string, string>, addr: string): number {
  const head = addr.split('/')[0]!.replace(/\[\d+\]$/, '');
  return flow.nodes.findIndex((node) => node.name === head);
}

function shapeOf(node: FlowNode): unknown {
  switch (node.type) {
    case 'step':
      return { type: node.type, name: node.name, exec: node.exec.entity, executable: node.exec.name };
    case 'halt':
      return { type: node.type, name: node.name, halt: node.halt.name, when: node.when !== undefined };
    case 'read':
      return { type: node.type, name: node.name, metric: node.metric.name };
    case 'spawn':
      return { type: node.type, name: node.name, lane: node.lane.name };
    case 'wait':
      return { type: node.type, name: node.name, ms: node.ms };
    case 'when':
      return { type: node.type, name: node.name, nodes: node.nodes.map(shapeOf) };
    case 'parallel':
      return { type: node.type, name: node.name, branches: Object.keys(node.branches).sort() };
    case 'loop':
      return { type: node.type, name: node.name, carry: node.carry !== undefined, span: node.bounds.span ?? 'attempt', nodes: node.nodes.map(shapeOf) };
    case 'exit':
      return { type: node.type, name: node.name, when: node.when !== undefined };
  }
}

export function flowVersion(flow: FlowDef<unknown, unknown, unknown, string, string>): string {
  return createHash('sha256').update(JSON.stringify({ name: flow.name, nodes: flow.nodes.map(shapeOf) })).digest('hex').slice(0, 16);
}
