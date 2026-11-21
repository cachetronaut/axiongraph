"""Runs the shared GraphStore contract (``axiongraph_testkit``) against both reference stores,
proving they are interchangeable (spec §Testability "Store contract"), plus a SQLite-specific
durability check.

The store API is async; tests drive it with ``asyncio.run`` to avoid a pytest-asyncio dependency."""

from __future__ import annotations

import asyncio
import sqlite3
import tempfile
from collections.abc import Callable
from pathlib import Path

import pytest
from axiongraph_core import GraphStore
from axiongraph_store_local import InMemoryStore, SqliteStore
from axiongraph_testkit import CONTRACT_CHECKS, ContractCheck, node_created

StoreFactory = Callable[[], GraphStore]

STORES: list[tuple[str, StoreFactory]] = [
    ("InMemoryStore", InMemoryStore),
    ("SqliteStore", SqliteStore),
]


@pytest.fixture(params=STORES, ids=[name for name, _ in STORES])
def store(request: pytest.FixtureRequest) -> GraphStore:
    _name, factory = request.param
    return factory()


@pytest.mark.parametrize(
    "check", [check for _, check in CONTRACT_CHECKS], ids=[name for name, _ in CONTRACT_CHECKS]
)
def test_store_contract(store: GraphStore, check: ContractCheck) -> None:
    asyncio.run(check(store))


def test_sqlite_persists_events_across_reopen() -> None:
    event = node_created("run_persist", 1, "a", "Persisted")
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "events.db")

        writer = SqliteStore(db_path)
        asyncio.run(writer.append([event]))
        writer.close()

        reader = SqliteStore(db_path)
        state = asyncio.run(reader.snapshot("run_persist"))
        reader.close()

    assert state.nodes["a"]["label"] == "Persisted"
    assert state.seq == 1


def test_sqlite_journal_mode_defaults_to_the_database_mode() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        store = SqliteStore(str(Path(tmp) / "events.db"))
        assert store.journal_mode == "delete"
        store.close()


def test_sqlite_rejects_unknown_journal_mode() -> None:
    with pytest.raises(ValueError):
        SqliteStore(":memory:", journal_mode="fast")


def test_sqlite_wal_append_commits_while_another_connection_reads() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "events.db")
        store = SqliteStore(db_path, journal_mode="wal")
        assert store.journal_mode == "wal"
        asyncio.run(store.append([node_created("run_wal", 1, "a", "First")]))

        # A reader holding an open read transaction, as another process would.
        reader = sqlite3.connect(db_path, isolation_level=None, timeout=0)
        reader.execute("BEGIN")
        assert reader.execute("SELECT count(*) FROM events").fetchone()[0] == 1

        asyncio.run(store.append([node_created("run_wal", 2, "b", "Second")]))
        # The reader keeps its own snapshot until it ends its transaction.
        assert reader.execute("SELECT count(*) FROM events").fetchone()[0] == 1
        reader.execute("COMMIT")
        assert reader.execute("SELECT count(*) FROM events").fetchone()[0] == 2
        reader.close()

        state = asyncio.run(store.snapshot("run_wal"))
        store.close()
    assert set(state.nodes) == {"a", "b"}


def test_sqlite_in_memory_reports_the_journal_mode_in_effect() -> None:
    store = SqliteStore(journal_mode="wal")
    assert store.journal_mode == "memory"
    store.close()
    store = SqliteStore(journal_mode="off")
    assert store.journal_mode == "off"
    store.close()


def test_sqlite_journal_mode_change_refused_while_another_connection_reads() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        db_path = str(Path(tmp) / "events.db")
        SqliteStore(db_path).close()
        reader = sqlite3.connect(db_path, isolation_level=None)
        reader.execute("BEGIN")
        reader.execute("SELECT count(*) FROM events").fetchone()
        with pytest.raises(sqlite3.OperationalError):
            SqliteStore(db_path, journal_mode="wal", timeout=0)
        reader.execute("COMMIT")
        reader.close()
        store = SqliteStore(db_path, journal_mode="wal")
        assert store.journal_mode == "wal"
        store.close()
