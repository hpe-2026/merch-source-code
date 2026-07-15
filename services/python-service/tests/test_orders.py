import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch, MagicMock
from bson import ObjectId

from app.main import app
from app.db.database import get_database

# Create a mock database and collection
mock_db = MagicMock()
mock_collection = MagicMock()
mock_db.__getitem__.return_value = mock_collection

async def override_get_database():
    return mock_db

client = TestClient(app)

@pytest.fixture(autouse=True)
def _override_db():
    app.dependency_overrides[get_database] = override_get_database
    yield
    app.dependency_overrides.pop(get_database, None)

@pytest.fixture
def reset_mocks():
    mock_collection.reset_mock()
    yield

def test_get_orders(reset_mocks):
    mock_collection.find.return_value.skip.return_value.limit.return_value.to_list = AsyncMock(return_value=[
        {
            "_id": ObjectId("507f1f77bcf86cd799439021"),
            "order_id": "ORD-00001",
            "user_id": "user123",
            "status": "pending",
            "items": [],
            "shipping_address": "Test addr"
        }
    ])

    response = client.get("/api/v1/orders/")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["order_id"] == "ORD-00001"

def test_get_order_by_id_success(reset_mocks):
    mock_collection.find_one = AsyncMock(return_value={
        "_id": ObjectId("507f1f77bcf86cd799439021"),
        "order_id": "ORD-00001",
        "user_id": "user123",
        "status": "pending",
        "items": [],
        "shipping_address": "Test addr"
    })

    response = client.get("/api/v1/orders/507f1f77bcf86cd799439021")
    assert response.status_code == 200
    assert response.json()["order_id"] == "ORD-00001"

def test_get_order_by_id_not_found(reset_mocks):
    mock_collection.find_one = AsyncMock(return_value=None)

    response = client.get("/api/v1/orders/507f1f77bcf86cd799439021")
    assert response.status_code == 404
    assert response.json()["detail"] == "Order not found"

def test_create_order(reset_mocks):
    mock_collection.count_documents = AsyncMock(return_value=0)
    mock_insert_result = MagicMock()
    mock_insert_result.inserted_id = ObjectId("507f1f77bcf86cd799439021")
    mock_collection.insert_one = AsyncMock(return_value=mock_insert_result)
    mock_collection.find_one = AsyncMock(return_value={
        "_id": ObjectId("507f1f77bcf86cd799439021"),
        "order_id": "ORD-00001",
        "user_id": "user123",
        "status": "pending",
        "items": [],
        "shipping_address": "Test addr"
    })

    order_data = {
        "user_id": "user123",
        "items": [],
        "shipping_address": "Test addr",
        "status": "pending"
    }

    response = client.post("/api/v1/orders/", json=order_data)
    assert response.status_code == 201
    assert response.json()["order_id"] == "ORD-00001"
