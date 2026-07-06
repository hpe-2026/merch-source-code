"""
conftest.py — pytest session fixtures for python-service CI tests.

Purpose:
    The application initialises OpenTelemetry/Jaeger and MongoDB at
    *module-import* time (app/main.py).  In a CI environment those
    infrastructure components are not present, so importing `app.main`
    without prior patching raises connection errors that prevent pytest
    from even collecting tests.

    This file patches those subsystems *before* any test module is
    imported, using the standard pytest `autouse` session-scoped
    fixture pattern.  No network calls are made during the test run.
"""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch


# ---------------------------------------------------------------------------
# 1. Patch Jaeger / OpenTelemetry at import time
# ---------------------------------------------------------------------------
# `app.main` calls `init_opentelemetry_jaeger()` unconditionally at module
# level (before the FastAPI `app` object is even created).  Patching the
# JaegerExporter before the module is loaded prevents the OSError that
# would otherwise abort collection.

@pytest.fixture(scope="session", autouse=True)
def patch_opentelemetry():
    """Replace JaegerExporter with a no-op for the entire test session."""
    with patch(
        "opentelemetry.exporter.jaeger.thrift.JaegerExporter",
        return_value=MagicMock()
    ), patch(
        "opentelemetry.sdk.trace.export.BatchSpanProcessor",
        return_value=MagicMock()
    ), patch(
        "opentelemetry.sdk.trace.TracerProvider",
        return_value=MagicMock()
    ):
        yield


# ---------------------------------------------------------------------------
# 2. Patch MongoDB at import time
# ---------------------------------------------------------------------------
# `app.db.database` creates a `MongoDatabase()` singleton at module level
# and `app.main` imports it.  The `connect()` / `disconnect()` methods are
# called from the FastAPI lifespan; the TestClient runs the lifespan, so
# we patch the async methods to be no-ops.

@pytest.fixture(scope="session", autouse=True)
def patch_database():
    """Replace MongoDB connect/disconnect with async no-ops."""
    with patch("app.db.database.MongoDatabase.connect", new_callable=AsyncMock), \
         patch("app.db.database.MongoDatabase.disconnect", new_callable=AsyncMock), \
         patch("app.db.database.MongoDatabase.get_db", return_value=MagicMock()):
        yield
