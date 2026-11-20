import type { EdgePayload, GraphEvent, GraphState, NodePayload } from './types';

/** Things the reducer noticed but did not apply. Observation only — never thrown (spec D6). */
export type AnomalyKind = 'wrong_run' | 'stale_seq' | 'update_unknown_node' | 'update_unknown_edge';

export interface Anomaly {
  readonly kind: AnomalyKind;
  readonly event: GraphEvent;
}

export interface ReduceOptions {
  readonly onAnomaly?: (anomaly: Anomaly) => void;
}

/** The fold's seed. `seq` starts at 0; the first applied event must have `seq >= 1`. */
export function emptyState(runId: string): GraphState {
  return { runId, nodes: new Map(), edges: new Map(), seq: 0 };
}

const EVENT_TYPES: ReadonlySet<string> = new Set([
  'node_created',
  'node_updated',
  'edge_created',
  'edge_updated',
]);

/** Whether the event belongs to this run and comes after `seq` (spec D3). */
function admit(
  runId: string,
  seq: number,
  event: GraphEvent,
  report: ReduceOptions['onAnomaly'],
): boolean {
  if (event.runId !== runId) {
    report?.({ kind: 'wrong_run', event });
    return false;
  }
  if (event.seq <= seq) {
    report?.({ kind: 'stale_seq', event });
    return false;
  }
  return true;
}

/**
 * Apply one in-order event for the run to `nodes` and `edges` in place and return the
 * resulting sequence. The single home of the reducer's rules, shared by `reduce` (on fresh
 * copies) and `reduceAll` (on one private copy for the whole fold).
 */
function applyEvent(
  nodes: Map<string, NodePayload>,
  edges: Map<string, EdgePayload>,
  seq: number,
  event: GraphEvent,
  report: ReduceOptions['onAnomaly'],
): number {
  switch (event.type) {
    case 'node_created':
      nodes.set(event.node.id, event.node);
      return event.seq;
    case 'node_updated': {
      const existing = nodes.get(event.node.id);
      if (existing === undefined) report?.({ kind: 'update_unknown_node', event });
      else nodes.set(existing.id, { ...existing, ...event.node } as NodePayload);
      return event.seq;
    }
    case 'edge_created':
      edges.set(event.edge.id, event.edge);
      return event.seq;
    case 'edge_updated': {
      const existing = edges.get(event.edge.id);
      if (existing === undefined) report?.({ kind: 'update_unknown_edge', event });
      else edges.set(existing.id, { ...existing, ...event.edge } as EdgePayload);
      return event.seq;
    }
  }
  return seq;
}

/**
 * Apply one event. Pure and deterministic (spec D5): no clock, no I/O. Events for a
 * different run, or with a non-increasing `seq`, are ignored idempotently (spec D3).
 */
export function reduce(
  state: GraphState,
  event: GraphEvent,
  options: ReduceOptions = {},
): GraphState {
  const report = options.onAnomaly;
  if (!admit(state.runId, state.seq, event, report)) return state;
  if (!EVENT_TYPES.has(event.type)) return state;
  const nodes = new Map(state.nodes);
  const edges = new Map(state.edges);
  const seq = applyEvent(nodes, edges, state.seq, event, report);
  return { runId: state.runId, nodes, edges, seq };
}

/**
 * Fold an event log into state. Sorts by `seq` first, so arrival order does not matter.
 * Equivalent to folding with `reduce` one event at a time, but linear in the log's length:
 * every event is applied to one private copy of the maps instead of copying them per event.
 */
export function reduceAll(
  runId: string,
  events: Iterable<GraphEvent>,
  options: ReduceOptions = {},
): GraphState {
  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  const nodes = new Map<string, NodePayload>();
  const edges = new Map<string, EdgePayload>();
  let seq = 0;
  for (const event of sorted) {
    if (admit(runId, seq, event, options.onAnomaly)) {
      seq = applyEvent(nodes, edges, seq, event, options.onAnomaly);
    }
  }
  return { runId, nodes, edges, seq };
}

/** Derive a filtered view: keep matching nodes and any edge whose endpoints both survive. */
export function subgraph(state: GraphState, keepNode: (node: NodePayload) => boolean): GraphState {
  const nodes = new Map<string, NodePayload>();
  for (const [id, node] of state.nodes) {
    if (keepNode(node)) {
      nodes.set(id, node);
    }
  }
  const edges = new Map<string, EdgePayload>();
  for (const [id, edge] of state.edges) {
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      edges.set(id, edge);
    }
  }
  return { runId: state.runId, nodes, edges, seq: state.seq };
}
