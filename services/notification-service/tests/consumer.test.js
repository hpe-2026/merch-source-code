import NotificationConsumer from '../src/kafka/consumer.js';
import emailService from '../src/services/emailService.js';
import config from '../src/config.js';
import logger from '../src/logger.js';

// Mock Dependencies
jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: jest.fn().mockReturnValue({
      connect: jest.fn().mockResolvedValue(true),
      subscribe: jest.fn().mockResolvedValue(true),
      run: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(true),
    })
  }))
}));

jest.mock('../src/services/emailService.js', () => ({
  sendApprovalEmail: jest.fn().mockResolvedValue(true),
  sendRejectionEmail: jest.fn().mockResolvedValue(true),
  sendOrderCreatedEmail: jest.fn().mockResolvedValue(true),
  sendEmail: jest.fn().mockResolvedValue(true),
  sendProductActionEmail: jest.fn().mockResolvedValue(true),
}));

jest.mock('../src/logger.js', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

jest.mock('../src/config.js', () => ({
  kafka: {
    clientId: 'test-client',
    brokers: ['localhost:9092'],
    consumerGroup: 'test-group',
    topics: {
      userApproved: 'user-approved',
      userRejected: 'user-rejected',
      orderEvents: 'order-events',
      productEvents: 'product-events',
      userActivity: 'user-activity'
    }
  },
  admin: {
    emails: ['admin@example.com']
  }
}));

describe('NotificationConsumer (Kafka)', () => {
  let consumerInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consumerInstance = new NotificationConsumer();
  });

  describe('initialize()', () => {
    it('should initialize kafka client and consumer', async () => {
      // Act
      await consumerInstance.initialize();

      // Assert
      expect(consumerInstance.isConnected).toBe(true);
      expect(consumerInstance.consumer.connect).toHaveBeenCalled();
      expect(consumerInstance.consumer.subscribe).toHaveBeenCalledTimes(5);
    });

    it('should throw and log error if connection fails', async () => {
      // Arrange
      await consumerInstance.initialize();
      consumerInstance.consumer.connect.mockRejectedValue(new Error('Broker unreachable'));

      // Act & Assert
      await expect(consumerInstance.initialize()).rejects.toThrow('Broker unreachable');
      expect(logger.error).toHaveBeenCalled();
      expect(consumerInstance.isConnected).toBe(false);
    });
  });

  describe('Message Routing: handleMessage()', () => {
    const createMockKafkaMessage = (topic, value) => ({
      topic,
      partition: 0,
      message: { value: Buffer.from(JSON.stringify(value)) }
    });

    it('should route userApproved topic to handleUserApproved', async () => {
      // Arrange
      jest.spyOn(consumerInstance, 'handleUserApproved').mockResolvedValue(true);
      const msg = createMockKafkaMessage('user-approved', { email: 'test@example.com' });

      // Act
      await consumerInstance.handleMessage(msg);

      // Assert
      expect(consumerInstance.handleUserApproved).toHaveBeenCalledWith({ email: 'test@example.com' });
    });

    it('should parse buffer correctly and handle orderEvents', async () => {
      // Arrange
      jest.spyOn(consumerInstance, 'handleOrderEvent').mockResolvedValue(true);
      const payload = { event: 'created', data: { order_id: '123' } };
      
      // Pass raw JSON string buffer
      await consumerInstance.handleMessage({
        topic: 'order-events',
        message: { value: Buffer.from(JSON.stringify(payload)) }
      });

      // Assert
      expect(consumerInstance.handleOrderEvent).toHaveBeenCalledWith(payload, 'created');
    });

    it('should gracefully handle malformed JSON', async () => {
      // Arrange
      const msg = { topic: 'user-approved', message: { value: Buffer.from('invalid-json') } };

      // Act & Assert
      await expect(consumerInstance.handleMessage(msg)).rejects.toThrow();
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Error parsing message'), expect.any(Object));
    });
  });

  describe('Business Logic: handleUserApproved()', () => {
    it('should send approval email', async () => {
      // Arrange
      const payload = { email: 'test@test.com', approved_by: 'Admin' };
      
      // Act
      await consumerInstance.handleUserApproved(payload);
      
      // Assert
      expect(emailService.sendApprovalEmail).toHaveBeenCalledWith(
        payload,
        'Admin',
        undefined // reason is optional
      );
    });
  });

  describe('Business Logic: notifyAdmins()', () => {
    it('should send email to all configured admins', async () => {
      // Act
      await consumerInstance.notifyAdmins('Subject', 'Body');

      // Assert
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        'admin@example.com',
        '[NITTE Admin] Subject',
        'Body',
        expect.stringContaining('Subject')
      );
    });

    it('should not crash if an admin email fails to send', async () => {
      // Arrange
      emailService.sendEmail.mockRejectedValue(new Error('SMTP failure'));
      
      // Act
      await consumerInstance.notifyAdmins('Subject', 'Body');
      
      // Assert
      expect(logger.warn).toHaveBeenCalledWith('Failed to notify admin:', expect.any(Object));
      // Does not throw
    });
  });
  
  describe('disconnect()', () => {
    it('should disconnect consumer if connected', async () => {
      // Arrange
      await consumerInstance.initialize();
      
      // Act
      await consumerInstance.disconnect();
      
      // Assert
      expect(consumerInstance.consumer.disconnect).toHaveBeenCalled();
      expect(consumerInstance.isConnected).toBe(false);
    });
  });
});
