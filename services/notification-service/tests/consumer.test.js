import { jest } from '@jest/globals';

// Mock Dependencies
jest.unstable_mockModule('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: jest.fn().mockReturnValue({
      connect: jest.fn().mockResolvedValue(true),
      subscribe: jest.fn().mockResolvedValue(true),
      run: jest.fn().mockResolvedValue(true),
      disconnect: jest.fn().mockResolvedValue(true),
    })
  }))
}));

jest.unstable_mockModule('../src/services/emailService.js', () => ({
  default: {
    sendApprovalEmail: jest.fn().mockResolvedValue(true),
    sendRejectionEmail: jest.fn().mockResolvedValue(true),
    sendOrderCreatedEmail: jest.fn().mockResolvedValue(true),
    sendEmail: jest.fn().mockResolvedValue(true),
    sendProductActionEmail: jest.fn().mockResolvedValue(true),
  }
}));

jest.unstable_mockModule('../src/services/slackService.js', () => ({
  default: {
    initialize: jest.fn().mockResolvedValue(true),
    sendMessage: jest.fn().mockResolvedValue({ success: true }),
    sendKeycloakAlert: jest.fn().mockResolvedValue({ success: true }),
  }
}));

jest.unstable_mockModule('../src/logger.js', () => ({
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  }
}));

jest.unstable_mockModule('../src/config.js', () => ({
  default: {
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
  }
}));

const NotificationConsumer = (await import('../src/kafka/consumer.js')).default;
const emailService = (await import('../src/services/emailService.js')).default;
const config = (await import('../src/config.js')).default;
const logger = (await import('../src/logger.js')).default;

describe('NotificationConsumer (Kafka)', () => {
  let consumerInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consumerInstance = new NotificationConsumer();
  });

  const triggerEachMessage = async (topic, value, headers = {}) => {
    await consumerInstance.initialize();
    await consumerInstance.startConsuming();
    
    const runCall = consumerInstance.consumer.run.mock.calls[0][0];
    const eachMessage = runCall.eachMessage;
    
    await eachMessage({
      topic,
      partition: 0,
      message: {
        value: Buffer.from(JSON.stringify(value)),
        headers: Object.keys(headers).reduce((acc, k) => {
          acc[k] = Buffer.from(headers[k]);
          return acc;
        }, {})
      }
    });
  };

  describe('initialize()', () => {
    it('should initialize kafka client and consumer', async () => {
      // Act
      await consumerInstance.initialize();

      // Assert
      expect(consumerInstance.isConnected).toBe(true);
      expect(consumerInstance.consumer.connect).toHaveBeenCalled();
      expect(consumerInstance.consumer.subscribe).toHaveBeenCalledWith({
        topics: [
          config.kafka.topics.userApproved,
          config.kafka.topics.userRejected,
          config.kafka.topics.orderEvents,
          config.kafka.topics.productEvents,
          config.kafka.topics.userActivity,
        ],
        fromBeginning: false,
      });
    });

    it('should throw and log error if connection fails', async () => {
      // Arrange & Act & Assert
      const mockConsumer = {
        connect: jest.fn().mockRejectedValueOnce(new Error('Broker unreachable')),
        subscribe: jest.fn(),
      };
      jest.spyOn(consumerInstance.kafka, 'consumer').mockReturnValue(mockConsumer);

      await expect(consumerInstance.initialize()).rejects.toThrow('Broker unreachable');
      expect(logger.error).toHaveBeenCalled();
      expect(consumerInstance.isConnected).toBe(false);
    });
  });

  describe('Message Routing', () => {
    it('should route userApproved topic to handleUserApproved', async () => {
      // Arrange
      jest.spyOn(consumerInstance, 'handleUserApproved').mockResolvedValue(true);
      const payload = { email: 'test@example.com' };

      // Act
      await triggerEachMessage('user-approved', payload);

      // Assert
      expect(consumerInstance.handleUserApproved).toHaveBeenCalledWith(payload, null);
    });

    it('should parse buffer correctly and handle orderEvents', async () => {
      // Arrange
      jest.spyOn(consumerInstance, 'handleOrderEvent').mockResolvedValue(true);
      const payload = { event: 'created', data: { order_id: '123' } };
      
      // Act
      await triggerEachMessage('order-events', payload, { 'event-type': 'created' });

      // Assert
      expect(consumerInstance.handleOrderEvent).toHaveBeenCalledWith(payload, 'created', null);
    });

    it('should gracefully handle malformed JSON', async () => {
      // Arrange
      await consumerInstance.initialize();
      await consumerInstance.startConsuming();
      const runCall = consumerInstance.consumer.run.mock.calls[0][0];
      const eachMessage = runCall.eachMessage;

      // Act & Assert
      await expect(
        eachMessage({
          topic: 'user-approved',
          partition: 0,
          message: { value: Buffer.from('invalid-json') }
        })
      ).resolves.not.toThrow();
      expect(logger.error).toHaveBeenCalledWith('Error processing message:', expect.any(String), expect.any(Object));
    });
  });

  describe('Business Logic: handleUserApproved()', () => {
    it('should send approval email', async () => {
      // Arrange
      const payload = { email: 'test@test.com', approved_by: 'Admin', approval_reason: 'Verified' };
      
      // Act
      await consumerInstance.handleUserApproved(payload);
      
      // Assert
      expect(emailService.sendApprovalEmail).toHaveBeenCalledWith(
        { name: 'Alumni', email: 'test@test.com', alumni_id: undefined },
        'Admin',
        'Verified'
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
