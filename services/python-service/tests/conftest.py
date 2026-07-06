"""
conftest.py  —  pytest fixtures for python-service CI tests.

Why this file exists
====================
The application initialises OpenTelemetry/Jaeger and resolves the MongoDB
client at *module-import* time.  In a CI pod there is no Jaeger agent and
no MongoDB, so without these fixtures every test collection would crash
before a single test runs.

Two layers of protection are provided:

1. `pytest_configure` hook  (runs before collection, before any import)
   Acts as a belt-and-suspenders guard in case an older OTel wheel is
   cached.  If `pkg_resources` is not importable, it is injected as a
   MagicMock so the import chain in opentelemetry.instrumentation.dependencies
   does not abort collection.

2. Session-scoped autouse fixtures  (run before the first test method)
   Patch the async MongoDB driver so every route that calls
   `Depends(get_database)` receives a properly-configured async mock
   instead of a None client or a network error.

Patching strategy for MongoDB
------------------------------
Motor uses a chained cursor API:

    collection.find(query).skip(n).limit(m).to_list(length=m)

Each chained call must return the *same* cursor object so that the next
call in the chain resolves correctly.  The final `.to_list()` is awaited,
so it must be an AsyncMock.  Every other method on the cursor is a regular
MagicMock that returns the cursor itself.

`get_database()` in app/db/database.py is the FastAPI dependency function
used via `Depends(get_database)`.  We patch it at the module level so all
route handlers that call `Depends(get_database)` receive our mock DB.
"""

import sys
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# 1. Early guard — runs before any test module is imported
# ---------------------------------------------------------------------------

def pytest_configure(config):
    """
    Inject a minimal pkg_resources stub if the real package is absent.

    opentelemetry-instrumentation <= 0.44b0 does `import pkg_resources`
    inside opentelemetry.instrumentation.dependencies at import time.
    This hook runs before pytest collection, so we can prevent the
    ModuleNotFoundError before it aborts collection.
    With opentelemetry-instrumentation >= 0.45b0 (our pinned version) this
    guard is a no-op because importlib.metadata is used instead.
    """
    if "pkg_resources" not in sys.modules:
        try:
            import pkg_resources  # noqa: F401  (unused import intentional)
        except ImportError:
            sys.modules["pkg_resources"] = MagicMock()


# ---------------------------------------------------------------------------
# 2. Async Motor cursor chain helper
# ---------------------------------------------------------------------------

def _make_async_cursor(return_list=None):
    """
    Build a Motor-compatible async cursor mock.

    Supports the chained call pattern used in every route:

        db[collection].find(query).skip(n).limit(m).to_list(length=m)

    Each chainable method returns the cursor itself.
    `.to_list()` is awaitable and returns `return_list` (default: []).
    """
    cursor = MagicMock()
    cursor.skip.return_value = cursor
    cursor.limit.return_value = cursor
    cursor.sort.return_value = cursor
    cursor.to_list = AsyncMock(return_value=return_list or [])
    return cursor


# ---------------------------------------------------------------------------
# 3. MongoDB async mock — activated before the first test method
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session", autouse=True)
def patch_database():
    """
    Replace all async MongoDB operations with in-process mocks.

    Route handlers reach MongoDB via two paths:
    a) `Depends(get_database)` in products.py / orders.py
    b) `database.connect()` / `database.disconnect()` in the FastAPI lifespan

    Both are patched here.  Because this is session-scoped and autouse,
    the patches are active for the entire test session.
    """

    # Build a reusable async cursor
    cursor = _make_async_cursor(return_list=[])

    # Track inserts so find_one can return a coherent document
    _last_inserted: dict = {}

    def _insert_side_effect(doc):
        """Store inserted doc so the subsequent find_one returns something valid."""
        _last_inserted.clear()
        _last_inserted.update(doc)
        _last_inserted["_id"] = "507f1f77bcf86cd799439011"
        return MagicMock(inserted_id="507f1f77bcf86cd799439011")

    def _find_one_side_effect(*args, **kwargs):
        """Return the last inserted document when the route does find_one after insert."""
        if _last_inserted:
            return _last_inserted.copy()
        return None

    # Build a mock collection that covers every Motor method used in routes
    mock_collection = MagicMock()
    mock_collection.find.return_value = cursor
    mock_collection.find_one = AsyncMock(side_effect=_find_one_side_effect)
    mock_collection.insert_one = AsyncMock(side_effect=_insert_side_effect)
    mock_collection.update_one = AsyncMock(
        return_value=MagicMock(matched_count=1, modified_count=1)
    )
    mock_collection.delete_one = AsyncMock(
        return_value=MagicMock(deleted_count=1)
    )
    mock_collection.count_documents = AsyncMock(return_value=0)
    mock_collection.create_index = AsyncMock(return_value="field_1")


    # Build a mock DB whose [] operator always returns the same collection
    mock_db = MagicMock()
    mock_db.__getitem__ = MagicMock(return_value=mock_collection)
    mock_db.command = AsyncMock(return_value={"ok": 1})

    with (
        # Patch the FastAPI dependency so routes get our mock DB.
        # get_database() is `async def`, so AsyncMock is required.
        patch("app.db.database.get_database", new_callable=AsyncMock, return_value=mock_db),
        # Also patch get_db() for any direct calls
        patch("app.db.database.MongoDatabase.get_db", return_value=mock_db),
        # Patch lifespan startup/shutdown so they don't touch MongoDB
        patch("app.db.database.MongoDatabase.connect", new_callable=AsyncMock),
        patch("app.db.database.MongoDatabase.disconnect", new_callable=AsyncMock),
        patch("app.db.database.MongoDatabase._create_indexes", new_callable=AsyncMock),
    ):
        yield

