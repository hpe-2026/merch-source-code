import pytest
from fastapi.testclient import TestClient
from unittest.mock import AsyncMock, patch, MagicMock
from bson import ObjectId

from app.main import app
from app.db.database import get_database

# Create a mock database and collection
mock_db = MagicMock()
mock_collection = AsyncMock()
mock_db.__getitem__.return_value = mock_collection

async def override_get_database():
    return mock_db

app.dependency_overrides[get_database] = override_get_database

client = TestClient(app)

@pytest.fixture
def reset_mocks():
    mock_collection.reset_mock()
    yield

def test_get_products(reset_mocks):
    mock_collection.find.return_value.skip.return_value.limit.return_value.to_list = AsyncMock(return_value=[
        {"_id": ObjectId("507f1f77bcf86cd799439011"), "name": "Product 1", "price": 10.0, "category": "shirts", "merchant_id": "merch1"},
        {"_id": ObjectId("507f1f77bcf86cd799439012"), "name": "Product 2", "price": 15.0, "category": "mugs", "merchant_id": "merch2"}
    ])

    response = client.get("/api/v1/products/")
    assert response.status_code == 200
    assert len(response.json()) == 2
    assert response.json()[0]["name"] == "Product 1"

def test_get_product_by_id_success(reset_mocks):
    mock_collection.find_one = AsyncMock(return_value={
        "_id": ObjectId("507f1f77bcf86cd799439011"), 
        "name": "Product 1", 
        "price": 10.0,
        "category": "shirts",
        "merchant_id": "merch1"
    })

    response = client.get("/api/v1/products/507f1f77bcf86cd799439011")
    assert response.status_code == 200
    assert response.json()["name"] == "Product 1"

def test_get_product_by_id_not_found(reset_mocks):
    mock_collection.find_one = AsyncMock(return_value=None)

    response = client.get("/api/v1/products/507f1f77bcf86cd799439011")
    assert response.status_code == 404
    assert response.json()["detail"] == "Product not found"

def test_get_product_by_id_invalid_id():
    response = client.get("/api/v1/products/invalid-id")
    assert response.status_code == 400
    assert response.json()["detail"] == "Invalid product ID"

def test_create_product(reset_mocks):
    mock_insert_result = MagicMock()
    mock_insert_result.inserted_id = ObjectId("507f1f77bcf86cd799439011")
    mock_collection.insert_one = AsyncMock(return_value=mock_insert_result)
    mock_collection.find_one = AsyncMock(return_value={
        "_id": ObjectId("507f1f77bcf86cd799439011"), 
        "name": "New Product", 
        "price": 25.0,
        "category": "caps",
        "merchant_id": "merch3"
    })

    product_data = {
        "name": "New Product",
        "description": "A great cap",
        "price": 25.0,
        "category": "caps",
        "stock": 100,
        "merchant_id": "merch3"
    }

    response = client.post("/api/v1/products/", json=product_data)
    assert response.status_code == 201
    assert response.json()["name"] == "New Product"
