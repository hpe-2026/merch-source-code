import { jest } from '@jest/globals';

jest.unstable_mockModule('../src/services/pythonServiceClient.js', () => ({
  default: {
    getOrders: jest.fn(),
    getOrderById: jest.fn(),
    createOrder: jest.fn(),
    updateOrder: jest.fn(),
  }
}));

jest.unstable_mockModule('../src/config/database.js', () => ({
  getMongoClient: () => ({
    db: () => ({
      collection: () => ({
        find: () => ({
          sort: () => ({
            toArray: jest.fn().mockResolvedValue([{ _id: '123', merchant_id: 'test' }]),
          }),
        }),
      }),
    }),
  })
}));

jest.unstable_mockModule('../src/metrics.js', () => ({
  ordersCreated: { inc: jest.fn() },
  databaseOperations: { inc: jest.fn() },
}));

jest.unstable_mockModule('../src/tracing.js', () => {
  const spanMock = {
    setAttribute: jest.fn(),
    setAttributes: jest.fn(),
    end: jest.fn(),
  };
  return {
    default: {
      startSpan: jest.fn(() => spanMock),
    },
    context: { active: jest.fn() },
  };
});

jest.unstable_mockModule('../src/middleware/index.js', () => ({
  authMiddleware: (req, res, next) => {
    req.user = { userId: 'user-123', email: 'user@test.com', roles: ['user'] };
    next();
  },
  adminMiddleware: (req, res, next) => next(),
  requireOrderOwnership: (req, res, next) => {
    req.ownership = { level: 'user' };
    next();
  },
  filterByOwnership: () => (req, res, next) => {
    req.ownershipFilter = { user_id: 'user-123' };
    next();
  },
  keycloakRequireAnyRole: () => (req, res, next) => next(),
}));

const request = (await import('supertest')).default;
const express = (await import('express')).default;
const ordersRouter = (await import('../src/routes/orders.js')).default;
const pythonServiceClient = (await import('../src/services/pythonServiceClient.js')).default;

const app = express();
app.use(express.json());
// Add a mock kafkaProducer to app locals for the order creation test
app.locals.kafkaProducer = {
  publishOrderCreatedEvent: jest.fn().mockResolvedValue(),
  publishOrderUpdatedEvent: jest.fn().mockResolvedValue(),
};
app.use('/api/v1/orders', ordersRouter);

describe('Orders Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/v1/orders', () => {
    it('should return a list of orders for the user', async () => {
      pythonServiceClient.getOrders.mockResolvedValue([{ order_id: 'ORD-123' }]);

      const response = await request(app).get('/api/v1/orders');
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(pythonServiceClient.getOrders).toHaveBeenCalledWith('user-123');
    });

    it('should handle errors gracefully', async () => {
      pythonServiceClient.getOrders.mockRejectedValue(new Error('Backend down'));

      const response = await request(app).get('/api/v1/orders');
      
      expect(response.status).toBe(500);
      expect(response.body.success).toBe(false);
      expect(response.body.message).toBe('Failed to fetch orders');
    });
  });

  describe('POST /api/v1/orders', () => {
    const validOrder = {
      items: [{ product_id: 'prod-1', quantity: 2 }],
      shipping_address: '123 Test St',
    };

    it('should validate missing items array', async () => {
      const response = await request(app)
        .post('/api/v1/orders')
        .send({ shipping_address: '123 Test St' });

      expect(response.status).toBe(400);
      expect(response.body.errors[0].msg).toBe('Items array is required');
    });

    it('should create an order successfully', async () => {
      pythonServiceClient.createOrder.mockResolvedValue({ order_id: 'ORD-UUID' });

      const response = await request(app)
        .post('/api/v1/orders')
        .send(validOrder);

      expect(response.status).toBe(201);
      expect(response.body.success).toBe(true);
      expect(pythonServiceClient.createOrder).toHaveBeenCalled();
      expect(app.locals.kafkaProducer.publishOrderCreatedEvent).toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/orders/:id', () => {
    it('should return an order by id', async () => {
      pythonServiceClient.getOrderById.mockResolvedValue({ order_id: 'ORD-123' });

      const response = await request(app).get('/api/v1/orders/ORD-123');
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.order_id).toBe('ORD-123');
    });
    
    it('should return 404 if order not found', async () => {
      pythonServiceClient.getOrderById.mockRejectedValue(new Error('Order not found'));

      const response = await request(app).get('/api/v1/orders/ORD-NOTFOUND');
      
      expect(response.status).toBe(404);
      expect(response.body.success).toBe(false);
    });
  });
});
