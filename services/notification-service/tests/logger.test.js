import { jest } from '@jest/globals';

jest.unstable_mockModule('winston', () => {
  const mFormat = {
    combine: jest.fn(),
    timestamp: jest.fn(),
    errors: jest.fn(),
    splat: jest.fn(),
    json: jest.fn(),
    colorize: jest.fn(),
    printf: jest.fn(),
  };
  const mTransports = {
    Console: jest.fn(),
    File: jest.fn(),
  };
  const mLogger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    add: jest.fn(),
  };
  const mockWinston = {
    format: mFormat,
    transports: mTransports,
    createLogger: jest.fn(() => mLogger),
  };
  return {
    ...mockWinston,
    default: mockWinston,
  };
});

const winston = (await import('winston')).default;
const logger = (await import('../src/logger.js')).default;

describe('Logger', () => {
  it('should create winston logger', () => {
    expect(winston.createLogger).toHaveBeenCalled();
  });
  
  it('should expose info, warn, error methods', () => {
    expect(logger.info).toBeDefined();
    expect(logger.warn).toBeDefined();
    expect(logger.error).toBeDefined();
  });
});
