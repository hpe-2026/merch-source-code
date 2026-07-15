import { jest } from '@jest/globals';

jest.unstable_mockModule('nodemailer', () => ({
  default: {
    createTransport: jest.fn(),
  }
}));

jest.unstable_mockModule('../src/logger.js', () => ({
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
}));

jest.unstable_mockModule('../src/config.js', () => ({
  default: {
    email: {
      enabled: true,
      provider: 'smtp',
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: {
          user: 'test_user',
          pass: 'test_pass',
        },
        from: 'noreply@example.com',
      },
    },
  }
}));

const nodemailer = (await import('nodemailer')).default;
const emailService = (await import('../src/services/emailService.js')).default;
const config = (await import('../src/config.js')).default;
const logger = (await import('../src/logger.js')).default;

describe('EmailService', () => {
  let mockTransporter;

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create a mock transporter object
    mockTransporter = {
      verify: jest.fn().mockResolvedValue(true),
      sendMail: jest.fn().mockResolvedValue({ messageId: '12345-abc' }),
      close: jest.fn().mockResolvedValue(true),
    };

    // Make nodemailer return the mock transporter
    nodemailer.createTransport.mockReturnValue(mockTransporter);

    // Reset emailService state
    emailService.transporter = null;
    emailService.isInitialized = false;
    emailService.provider = 'smtp';
    
    // Reset config
    config.email.enabled = true;
    config.email.provider = 'smtp';
  });

  describe('initialize()', () => {
    it('should initialize successfully in smtp mode', async () => {
      // Arrange & Act
      await emailService.initialize();

      // Assert
      expect(nodemailer.createTransport).toHaveBeenCalledWith(expect.objectContaining({
        host: 'smtp.example.com',
        auth: { user: 'test_user', pass: 'test_pass' }
      }));
      expect(mockTransporter.verify).toHaveBeenCalled();
      expect(emailService.isInitialized).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(
        'Email service initialized with SMTP provider',
        expect.any(Object)
      );
    });

    it('should fallback to console mode if SMTP credentials are missing', async () => {
      // Arrange
      config.email.smtp.auth.user = null; // simulate missing credentials

      // Act
      await emailService.initialize();

      // Assert
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
      expect(emailService.provider).toBe('console');
      expect(emailService.isInitialized).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('falling back to CONSOLE mode'));

      // Restore
      config.email.smtp.auth.user = 'test_user';
    });

    it('should fallback to console mode if SMTP verify fails', async () => {
      // Arrange
      mockTransporter.verify.mockRejectedValue(new Error('Connection timeout'));

      // Act
      await emailService.initialize();

      // Assert
      expect(emailService.provider).toBe('console');
      expect(emailService.isInitialized).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('SMTP connection failed'),
        expect.stringContaining('Connection timeout')
      );
    });
    
    it('should initialize in console mode directly', async () => {
      // Arrange
      emailService.provider = 'console';
      
      // Act
      await emailService.initialize();
      
      // Assert
      expect(nodemailer.createTransport).not.toHaveBeenCalled();
      expect(emailService.isInitialized).toBe(true);
    });
  });

  describe('sendEmail() - Core router', () => {
    beforeEach(async () => {
      // Ensure it's initialized for routing tests
      await emailService.initialize();
    });

    it('should abort if email service is disabled in config', async () => {
      // Arrange
      config.email.enabled = false;

      // Act
      const result = await emailService.sendEmail('test@example.com', 'Subject', 'Text');

      // Assert
      expect(result).toEqual({ success: false, message: 'Email service disabled' });
      expect(mockTransporter.sendMail).not.toHaveBeenCalled();
    });

    it('should return error if not initialized', async () => {
      // Arrange
      emailService.isInitialized = false;

      // Act
      const result = await emailService.sendEmail('test@example.com', 'Subject', 'Text');

      // Assert
      expect(result).toEqual({ success: false, message: 'Email service not initialized' });
    });

    it('should route to SMTP by default', async () => {
      // Act
      const result = await emailService.sendEmail('test@example.com', 'Subject', 'Text');

      // Assert
      expect(mockTransporter.sendMail).toHaveBeenCalledWith(expect.objectContaining({
        to: 'test@example.com',
        subject: 'Subject',
        text: 'Text',
      }));
      expect(result).toEqual({ success: true, mode: 'smtp', messageId: '12345-abc' });
    });
    
    it('should fallback to console if SMTP send fails', async () => {
      // Arrange
      mockTransporter.sendMail.mockRejectedValue(new Error('SMTP Crash'));
      
      // Act
      const result = await emailService.sendEmail('test@example.com', 'Subject', 'Text');
      
      // Assert
      expect(logger.error).toHaveBeenCalledWith('Error sending email:', 'SMTP Crash');
      // Should fallback to console
      expect(result.mode).toBe('console');
      expect(result.success).toBe(true);
    });
  });

  describe('Business Logic Formatting Methods', () => {
    beforeEach(async () => {
      await emailService.initialize();
      // Spy on the core sendEmail to prevent actual sending but verify routing
      jest.spyOn(emailService, 'sendEmail').mockResolvedValue({ success: true, mode: 'mocked' });
    });

    it('should sendApprovalEmail with correct data', async () => {
      // Arrange
      const user = { name: 'John Doe', email: 'john@nitte.edu' };
      
      // Act
      await emailService.sendApprovalEmail(user, 'Admin', 'Verified');

      // Assert
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        'john@nitte.edu',
        expect.stringContaining('Approved'),
        expect.stringContaining('Verified'),
        expect.stringContaining('john@nitte.edu') // simple HTML check
      );
    });

    it('should sendRejectionEmail with correct data', async () => {
      // Arrange
      const user = { name: 'Jane Doe', email: 'jane@nitte.edu' };
      
      // Act
      await emailService.sendRejectionEmail(user, 'Admin', 'Invalid ID');

      // Assert
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        'jane@nitte.edu',
        expect.stringContaining('Status Update'),
        expect.stringContaining('Invalid ID'),
        expect.any(String)
      );
    });
    
    it('should sendOrderCreatedEmail with formatting', async () => {
      // Act
      await emailService.sendOrderCreatedEmail('buyer@nitte.edu', 'ORD-123', 'T-Shirt', 500, 'Campus');
      
      // Assert
      expect(emailService.sendEmail).toHaveBeenCalledWith(
        'buyer@nitte.edu',
        expect.stringContaining('Order Has Been Placed'),
        expect.stringContaining('₹500'),
        expect.stringContaining('ORD-123')
      );
    });
  });
  
  describe('disconnect()', () => {
    it('should close transporter if exists', async () => {
      // Arrange
      await emailService.initialize();
      
      // Act
      await emailService.disconnect();
      
      // Assert
      expect(mockTransporter.close).toHaveBeenCalled();
    });
  });
});
