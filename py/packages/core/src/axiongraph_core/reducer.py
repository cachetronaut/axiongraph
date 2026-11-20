"""The deterministic reducer. Pure and side-effect free (spec D5): no clock, no I/O,
no randomness. Identical event sequences fold to identical state."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, replace
from typing import Any, Literal, cast

from .types import EdgePayload, GraphEvent, GraphState, NodePayload

AnomalyKind = Literal["wrong_run", "stale_seq", "update_unknown_node", "update_unknown_edge"]


@dataclass(frozen=True)
class Anomaly:
    """Something the reducer noticed but did not apply. Observation only, never raised."""

    kind: AnomalyKind
    event: GraphEvent


OnAnomaly = Callable[[Anomaly], None]


def empty_state(run_id: str) -> GraphState:
    """The fold's seed. ``seq`` starts at 0; the first applied event must have ``seq >= 1``."""
    return GraphState(run_id=run_id, nodes={}, edges={}, seq=0)


def _report(on_anomaly: OnAnomaly | None, kind: AnomalyKind, event: GraphEvent) -> None:
    if on_anomaly is not None:
        on_anomaly(Anomaly(kind=kind, event=event))


def _apply(
    nodes: dict[str, NodePayload],
    edges: dict[str, EdgePayload],
    seq: int,
    event: GraphEvent,
    on_anomaly: OnAnomaly | None,
) -> int:
    """Apply one in-order event for the run to ``nodes`` and ``edges`` in place; return the
    resulting sequence. The single home of the reducer's rules, shared by ``reduce`` (on fresh
    copies) and ``reduce_all`` (on one private copy for the whole fold)."""
    event_type = event["type"]

    if event_type == "node_created":
        node = cast(NodePayload, event["node"])
        nodes[node["id"]] = node
        return event["seq"]

    if event_type == "node_updated":
        update = event["node"]
        existing = nodes.get(update["id"])
        if existing is None:
            _report(on_anomaly, "update_unknown_node", event)
        else:
            nodes[update["id"]] = cast(NodePayload, {**existing, **update})
        return event["seq"]

    if event_type == "edge_created":
        edge = cast(EdgePayload, event["edge"])
        edges[edge["id"]] = edge
        return event["seq"]

    if event_type == "edge_updated":
        update = event["edge"]
        existing = edges.get(update["id"])
        if existing is None:
            _report(on_anomaly, "update_unknown_edge", event)
        else:
            edges[update["id"]] = cast(EdgePayload, {**existing, **update})
        return event["seq"]

    return seq


def _admit(run_id: str, seq: int, event: GraphEvent, on_anomaly: OnAnomaly | None) -> bool:
    """Whether the event belongs to this run and comes after ``seq`` (spec D3)."""
    if event["runId"] != run_id:
        _report(on_anomaly, "wrong_run", event)
        return False
    if event["seq"] <= seq:
        _report(on_anomaly, "stale_seq", event)
        return False
    return True


def reduce(state: GraphState, event: GraphEvent, on_anomaly: OnAnomaly | None = None) -> GraphState:
    """Apply one event. Events for another run, or with a non-increasing ``seq``, are
    ignored idempotently (spec D3). Updates to unknown ids are dropped (spec D6)."""
    if not _admit(state.run_id, state.seq, event, on_anomaly):
        return state
    if event["type"] not in ("node_created", "node_updated", "edge_created", "edge_updated"):
        return state
    nodes, edges = dict(state.nodes), dict(state.edges)
    seq = _apply(nodes, edges, state.seq, event, on_anomaly)
    return replace(state, nodes=nodes, edges=edges, seq=seq)


def reduce_all(
    run_id: str, events: Iterable[GraphEvent], on_anomaly: OnAnomaly | None = None
) -> GraphState:
    """Fold an event log into state. Sorted by ``seq`` first, so arrival order does not matter.

    Equivalent to folding with ``reduce`` one event at a time, but linear in the log's length:
    the fold applies every event to one private copy of the maps instead of copying them per
    event."""
    nodes: dict[str, NodePayload] = {}
    edges: dict[str, EdgePayload] = {}
    seq = 0
    for event in sorted(events, key=lambda candidate: candidate["seq"]):
        if _admit(run_id, seq, event, on_anomaly):
            seq = _apply(nodes, edges, seq, event, on_anomaly)
    return GraphState(run_id=run_id, nodes=nodes, edges=edges, seq=seq)


def subgraph(state: GraphState, keep_node: Callable[[NodePayload], bool]) -> GraphState:
    """Derive a filtered view: keep matching nodes and any edge whose endpoints both survive."""
    nodes = {node_id: node for node_id, node in state.nodes.items() if keep_node(node)}
    edges: dict[str, EdgePayload] = {}
    for edge_id, edge in state.edges.items():
        endpoints: dict[str, Any] = cast(dict[str, Any], edge)
        if endpoints["from"] in nodes and endpoints["to"] in nodes:
            edges[edge_id] = edge
    return replace(state, nodes=nodes, edges=edges)
