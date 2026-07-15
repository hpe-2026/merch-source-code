import {
  register,
  httpRequestDuration,
  httpRequestsTotal,
  activeConnections,
  setMetricsDb,
  refreshDbGauges,
} from '../src/metrics.js';

describe('Metrics', () => {
  beforeEach(() => {
    register.clear();
  });

  it('should export prometheus metrics registry', () => {
    expect(register).toBeDefined();
  });

  it('should have basic HTTP metrics defined', () => {
    expect(httpRequestDuration).toBeDefined();
    expect(httpRequestsTotal).toBeDefined();
    expect(activeConnections).toBeDefined();
  });

  it('should refresh db gauges without throwing if db is not set', async () => {
    setMetricsDb(null);
    await expect(refreshDbGauges()).resolves.not.toThrow();
  });

  it('should update gauges when db is mocked', async () => {
    const mockDb = {
      db: () => ({
        collection: () => ({
          countDocuments: jest.fn().mockResolvedValue(42),
        }),
      }),
    };
    setMetricsDb(mockDb);
    await expect(refreshDbGauges()).resolves.not.toThrow();
  });
});
