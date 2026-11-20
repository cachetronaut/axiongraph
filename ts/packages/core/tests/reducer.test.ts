import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/canonical';
import { type Anomaly, emptyState, reduce, reduceAll } from '../src/reducer';
import type { GraphEvent } from '../src/types';
import { exampleVocabulary, validate } from '../src/vocabulary';

const RUN = 'run_1';

function nodeCreated(seq: number, id: string, label: string): GraphEvent {
  return {
    id: `e${seq}`,
    runId: RUN,
    seq,
    ts: '2026-06-03T00:00:00.000Z',
    type: 'node_created',
    node: { id, kind: 'agent', label },
  };
}

describe('reduce', () => {
  it('creates then shallow-merges a node update (D6)', () => {
    const events: GraphEvent[] = [
      nodeCreated(1, 'a', 'Researcher'),
      {
        id: 'e2',
        runId: RUN,
        seq: 2,
        ts: '2026-06-03T00:00:01.000Z',
        type: 'node_updated',
        node: { id: 'a', label: 'Research Agent' },
      },
    ];
    const state = reduceAll(RUN, events);
    expect(state.nodes.get('a')).toEqual({ id: 'a', kind: 'agent', label: 'Research Agent' });
    expect(state.seq).toBe(2);
  });

  it('is idempotent on a duplicate seq (D3)', () => {
    const event = nodeCreated(1, 'a', 'A');
    const once = reduce(emptyState(RUN), event);
    const twice = reduce(once, event);
    expect(canonicalize(twice)).toBe(canonicalize(once));
  });

  it('ignores a stale seq and reports it (D3)', () => {
    const anomalies: Anomaly[] = [];
    let state = reduce(emptyState(RUN), nodeCreated(2, 'a', 'A'));
    state = reduce(state, nodeCreated(1, 'b', 'B'), { onAnomaly: (a) => anomalies.push(a) });
    expect(state.nodes.has('b')).toBe(false);
    expect(anomalies[0]?.kind).toBe('stale_seq');
  });

  it('drops an update to an unknown node, advances seq, and reports it (D6)', () => {
    const anomalies: Anomaly[] = [];
    const state = reduce(
      emptyState(RUN),
      {
        id: 'e1',
        runId: RUN,
        seq: 1,
        ts: '2026-06-03T00:00:00.000Z',
        type: 'node_updated',
        node: { id: 'ghost', label: 'x' },
      },
      { onAnomaly: (a) => anomalies.push(a) },
    );
    expect(state.nodes.size).toBe(0);
    expect(state.seq).toBe(1);
    expect(anomalies[0]?.kind).toBe('update_unknown_node');
  });

  it('is order-independent in reduceAll (D3)', () => {
    const a = nodeCreated(1, 'a', 'A');
    const b = nodeCreated(2, 'b', 'B');
    const c = nodeCreated(3, 'c', 'C');
    expect(canonicalize(reduceAll(RUN, [c, a, b]))).toBe(canonicalize(reduceAll(RUN, [a, b, c])));
  });
});

describe('validate', () => {
  it('accepts a known kind and rejects an unknown one (D2)', () => {
    expect(validate(nodeCreated(1, 'a', 'A'), exampleVocabulary).ok).toBe(true);
    const bad: GraphEvent = {
      id: 'e1',
      runId: RUN,
      seq: 1,
      ts: '2026-06-03T00:00:00.000Z',
      type: 'node_created',
      node: { id: 'a', kind: 'wizard', label: 'A' },
    };
    expect(validate(bad, exampleVocabulary).ok).toBe(false);
  });
});

/** A seeded, shuffled log mixing creates, updates, updates to unknown ids, other runs and repeats. */
function randomLog(seed: number, length: number): GraphEvent[] {
  let state = seed + 1;
  const next = () => {
    state = (state * 16807) % 2147483647;
    return state / 2147483647;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  const ids = Array.from(
    { length: Math.max(2, Math.floor(length / 4)) },
    (_, index) => `n${index}`,
  );
  const events: GraphEvent[] = [];
  for (let seq = 1; seq <= length; seq += 1) {
    const id = pick(ids);
    const other = pick(ids);
    const choice = Math.floor(next() * 6);
    const base = {
      id: `e${seq}`,
      runId: choice ? RUN : 'run_other',
      seq,
      ts: '2026-06-03T00:00:00.000Z',
    };
    if (choice === 1 || choice === 2) {
      events.push({ ...base, type: 'node_created', node: { id, kind: 'agent', label: `L${seq}` } });
    } else if (choice === 3) {
      events.push({ ...base, type: 'node_updated', node: { id, label: `U${seq}` } });
    } else if (choice === 4) {
      events.push({
        ...base,
        type: 'edge_created',
        edge: { id: `${id}-${other}`, kind: 'calls', from: id, to: other, status: 'active' },
      });
    } else {
      events.push({
        ...base,
        type: 'edge_updated',
        edge: { id: `${id}-${other}`, status: 'completed' },
      });
    }
    if (next() < 0.1) events.push({ ...(events.at(-1) as GraphEvent), id: `dup${seq}` });
  }
  for (let index = events.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    [events[index], events[swap]] = [events[swap] as GraphEvent, events[index] as GraphEvent];
  }
  return events;
}

describe('reduceAll', () => {
  it('matches folding reduce one event at a time, anomalies included', () => {
    for (let seed = 0; seed < 25; seed += 1) {
      const events = randomLog(seed, 300);
      const stepwise: Anomaly[] = [];
      let state = emptyState(RUN);
      for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
        state = reduce(state, event, { onAnomaly: (anomaly) => stepwise.push(anomaly) });
      }
      const folded: Anomaly[] = [];
      const result = reduceAll(RUN, events, { onAnomaly: (anomaly) => folded.push(anomaly) });
      expect(canonicalize(result)).toBe(canonicalize(state));
      expect(result.seq).toBe(state.seq);
      expect(folded).toEqual(stepwise);
    }
  });

  it('never mutates its input events', () => {
    const events = randomLog(7, 60);
    const before = JSON.stringify(events);
    reduceAll(RUN, events);
    expect(JSON.stringify(events)).toBe(before);
  });
});
