"""A durable single-file GraphStore backed by the stdlib ``sqlite3`` (spec D4). One ``events``
table keyed on ``(run_id, seq)``; ``append`` uses ``INSERT OR IGNORE`` so it is idempotent on
``(runId, seq)``. No server, survives restarts. Snapshots live-fold the log."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import AsyncIterator, Sequence
from typing import cast

from axiongraph_core import GraphEvent, GraphState, reduce_all

# SQLite's journal modes (https://sqlite.org/pragma.html#pragma_journal_mode).
JOURNAL_MODES = frozenset({"delete", "truncate", "persist", "memory", "wal", "off"})


class SqliteStore:
    """A :class:`~axiongraph_core.GraphStore` persisted to a single SQLite database file."""

    def __init__(
        self, location: str = ":memory:", *, journal_mode: str | None = None, timeout: float = 5.0
    ) -> None:
        """``location`` is a file path, or ``":memory:"`` (default) for an ephemeral database.

        ``journal_mode`` sets SQLite's journal mode when the store opens: ``"wal"`` lets readers
        in other connections or processes keep reading while ``append`` commits, rather than the
        commit waiting for them. ``None`` (default) leaves the database's current mode. Changing
        the mode needs the database to itself, so it raises ``sqlite3.OperationalError`` while
        another connection holds it. An in-memory database stays in ``"memory"`` mode for any
        other request, but takes ``"off"``. ``"off"`` disables the rollback journal, so a failed
        or interrupted ``append`` may leave the database inconsistent. ``journal_mode`` (the
        attribute) reports the mode in effect.

        ``timeout`` is how many seconds a statement waits for another connection's lock before
        raising ``sqlite3.OperationalError`` (``sqlite3.connect``'s own default). ``0`` never
        waits, for example to try a journal-mode change without blocking.
        """
        if journal_mode is not None and journal_mode not in JOURNAL_MODES:
            raise ValueError(f"journal_mode must be one of {sorted(JOURNAL_MODES)} or None")
        self._db = sqlite3.connect(location, timeout=timeout)
        try:
            if journal_mode is not None:
                self._db.execute(f"PRAGMA journal_mode={journal_mode}")
            self.journal_mode: str = self._db.execute("PRAGMA journal_mode").fetchone()[0]
        except BaseException:
            self._db.close()
            raise
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS events ("
            "  run_id  TEXT    NOT NULL,"
            "  seq     INTEGER NOT NULL,"
            "  payload TEXT    NOT NULL,"
            "  PRIMARY KEY (run_id, seq)"
            ")"
        )

    async def append(self, events: Sequence[GraphEvent]) -> None:
        self._db.executemany(
            "INSERT OR IGNORE INTO events (run_id, seq, payload) VALUES (?, ?, ?)",
            [(event["runId"], event["seq"], json.dumps(event)) for event in events],
        )
        self._db.commit()

    async def read_events(self, run_id: str, since_seq: int = 0) -> AsyncIterator[GraphEvent]:
        rows = self._db.execute(
            "SELECT payload FROM events WHERE run_id = ? AND seq > ? ORDER BY seq",
            (run_id, since_seq),
        ).fetchall()
        for (payload,) in rows:
            yield cast(GraphEvent, json.loads(payload))

    async def snapshot(self, run_id: str) -> GraphState:
        rows = self._db.execute(
            "SELECT payload FROM events WHERE run_id = ? ORDER BY seq", (run_id,)
        ).fetchall()
        return reduce_all(run_id, [cast(GraphEvent, json.loads(payload)) for (payload,) in rows])

    def close(self) -> None:
        """Release the underlying database handle. Not part of the ``GraphStore`` port."""
        self._db.close()
