import { jest } from '@jest/globals';

jest.unstable_mockModule('axios', () => ({
  default: {
    post: jest.fn(),
    get: jest.fn(),
  }
}));
jest.unstable_mockModule('../src/schemas/user.js', () => ({
  default: {
    findOne: jest.fn(),
  }
}));
jest.unstable_mockModule('../src/config/keycloak.js', () => ({
  default: {
    getTokenUrl: jest.fn().mockReturnValue('http://mock-keycloak/token'),
    clientId: 'mock-client',
    clientSecret: 'mock-secret',
    decodeToken: jest.fn(),
    extractUserInfo: jest.fn(),
    getHealthStatus: jest.fn(),
    logout: jest.fn(),
  }
}));
jest.unstable_mockModule('../src/metrics.js', () => ({
  authAttempts: { inc: jest.fn() },
}));
jest.unstable_mockModule('../src/config/logger.js', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }
}));
jest.unstable_mockModule('../src/middleware/keycloak.js', () => ({
  keycloakAuthMiddleware: (req, res, next) => {
    req.user = { userId: '123', email: 'test@admin.com', roles: ['admin'] };
    next();
  },
}));

const request = (await import('supertest')).default;
const express = (await import('express')).default;
const authRouter = (await import('../src/routes/auth.js')).default;
const axios = (await import('axios')).default;
const User = (await import('../src/schemas/user.js')).default;
const keycloakConfig = (await import('../src/config/keycloak.js')).default;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/auth', authRouter);

describe('Auth Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/v1/admin/auth/login', () => {
    it('should return 400 if validation fails', async () => {
      const response = await request(app).post('/api/v1/admin/auth/login').send({
        email: 'invalid-email',
      });
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should login successfully for admin users', async () => {
      axios.post.mockResolvedValue({
        status: 200,
        data: { access_token: 'mock-token', refresh_token: 'mock-refresh', expires_in: 3600 },
      });
      keycloakConfig.decodeToken.mockReturnValue({ sub: '123' });
      keycloakConfig.extractUserInfo.mockReturnValue({
        userId: '123',
        email: 'admin@test.com',
        roles: ['admin'],
        name: 'Admin User',
      });
      User.findOne.mockResolvedValue({ email: 'admin@test.com', roles: ['admin'] });

      const response = await request(app).post('/api/v1/admin/auth/login').send({
        email: 'admin@test.com',
        password: 'Password123',
      });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.email).toBe('admin@test.com');
      expect(response.body.tokens.access_token).toBe('mock-token');
    });

    it('should forbid non-admin/merchant users', async () => {
      axios.post.mockResolvedValue({
        status: 200,
        data: { access_token: 'mock-token', refresh_token: 'mock-refresh', expires_in: 3600 },
      });
      keycloakConfig.decodeToken.mockReturnValue({ sub: '123' });
      keycloakConfig.extractUserInfo.mockReturnValue({
        userId: '123',
        email: 'user@test.com',
        roles: ['user'],
        name: 'Normal User',
      });

      const response = await request(app).post('/api/v1/admin/auth/login').send({
        email: 'user@test.com',
        password: 'Password123',
      });

      expect(response.status).toBe(403);
      expect(response.body.message).toBe('Admin or Merchant account required');
    });

    it('should handle invalid credentials', async () => {
      axios.post.mockResolvedValue({
        status: 401,
        data: { error: 'unauthorized_client' },
      });

      const response = await request(app).post('/api/v1/admin/auth/login').send({
        email: 'admin@test.com',
        password: 'wrongpassword',
      });

      expect(response.status).toBe(401);
      expect(response.body.message).toBe('Invalid email or password');
    });
  });

  describe('GET /api/v1/admin/auth/me', () => {
    it('should return authenticated user details', async () => {
      const response = await request(app).get('/api/v1/admin/auth/me');
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.email).toBe('test@admin.com');
    });
  });

  describe('POST /api/v1/admin/auth/logout', () => {
    it('should logout user', async () => {
      keycloakConfig.logout.mockResolvedValue();
      const response = await request(app)
        .post('/api/v1/admin/auth/logout')
        .send({ refresh_token: 'mock-refresh' });
      
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(keycloakConfig.logout).toHaveBeenCalledWith('mock-refresh');
    });
  });
});
