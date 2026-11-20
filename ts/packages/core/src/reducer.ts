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

type NodeEvent = Extract<GraphEvent, { type: 'node_created' | 'node_updated' }>;
type EdgeEvent = Extract<GraphEvent, { type: 'edge_created' | 'edge_updated' }>;

/**
 * Apply one admitted node event to `nodes` in place. Shared by `reduce` (on a fresh copy)
 * and `reduceAll` (on one private map for the whole fold).
 */
function applyNode(
  nodes: Map<string, NodePayload>,
  event: NodeEvent,
  report: ReduceOptions['onAnomaly'],
): void {
  if (event.type === 'node_created') {
    nodes.set(event.node.id, event.node);
    return;
  }
  const existing = nodes.get(event.node.id);
  if (existing === undefined) report?.({ kind: 'update_unknown_node', event });
  else nodes.set(existing.id, { ...existing, ...event.node } as NodePayload);
}

/** Apply one admitted edge event to `edges` in place, as `applyNode` does nodes. */
function applyEdge(
  edges: Map<string, EdgePayload>,
  event: EdgeEvent,
  report: ReduceOptions['onAnomaly'],
): void {
  if (event.type === 'edge_created') {
    edges.set(event.edge.id, event.edge);
    return;
  }
  const existing = edges.get(event.edge.id);
  if (existing === undefined) report?.({ kind: 'update_unknown_edge', event });
  else edges.set(existing.id, { ...existing, ...event.edge } as EdgePayload);
}

/**
 * Apply one event. Pure and deterministic (spec D5): no clock, no I/O. Events for a
 * different run, or with a non-increasing `seq`, are ignored idempotently (spec D3).
 * Only the map the event changes is copied; an update to an unknown id copies neither.
 */
export function reduce(
  state: GraphState,
  event: GraphEvent,
  options: ReduceOptions = {},
): GraphState {
  const report = options.onAnomaly;
  if (!admit(state.runId, state.seq, event, report)) return state;
  switch (event.type) {
    case 'node_created':
    case 'node_updated': {
      if (event.type === 'node_updated' && !state.nodes.has(event.node.id)) {
        report?.({ kind: 'update_unknown_node', event });
        return { runId: state.runId, nodes: state.nodes, edges: state.edges, seq: event.seq };
      }
      const nodes = new Map(state.nodes);
      applyNode(nodes, event, report);
      return { runId: state.runId, nodes, edges: state.edges, seq: event.seq };
    }
    case 'edge_created':
    case 'edge_updated': {
      if (event.type === 'edge_updated' && !state.edges.has(event.edge.id)) {
        report?.({ kind: 'update_unknown_edge', event });
        return { runId: state.runId, nodes: state.nodes, edges: state.edges, seq: event.seq };
      }
      const edges = new Map(state.edges);
      applyEdge(edges, event, report);
      return { runId: state.runId, nodes: state.nodes, edges, seq: event.seq };
    }
  }
  return state;
}

/**
 * Fold an event log into state. Sorts by `seq` first, so arrival order does not matter.
 * Equivalent to folding with `reduce` one event at a time, but linear in the log's length:
 * every event is applied to one private pair of maps instead of copying them per event.
 */
export function reduceAll(
  runId: string,
  events: Iterable<GraphEvent>,
  options: ReduceOptions = {},
): GraphState {
  const report = options.onAnomaly;
  const sorted = [...events].sort((left, right) => left.seq - right.seq);
  const nodes = new Map<string, NodePayload>();
  const edges = new Map<string, EdgePayload>();
  let seq = 0;
  for (const event of sorted) {
    if (!admit(runId, seq, event, report)) continue;
    switch (event.type) {
      case 'node_created':
      case 'node_updated':
        applyNode(nodes, event, report);
        seq = event.seq;
        break;
      case 'edge_created':
      case 'edge_updated':
        applyEdge(edges, event, report);
        seq = event.seq;
        break;
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
