const express = require('express');
const cron = require('node-cron');
const config = require('./config');
const logger = require('./logger');
const metrics = require('./metrics');
const backupRoutes = require('./routes/backup');
const { performBackup } = require('./services/backupService');

const app = express();

// Middleware
app.use(express.json());

// Routes
app.use(backupRoutes);

// Schedule daily backup
const scheduledTask = cron.schedule(config.backup.schedule, async () => {
  logger.info('Scheduled backup starting', { schedule: config.backup.schedule });
  try {
    await performBackup(metrics);
    logger.info('Scheduled backup completed successfully');
  } catch (error) {
    logger.error('Scheduled backup failed', { error: error.message });
  }
}, {
  timezone: 'UTC',
});

// Start server
app.listen(config.port, () => {
  logger.info(`Backup service started on port ${config.port}`);
  logger.info(`Backup schedule: ${config.backup.schedule} (UTC)`);
  logger.info(`MongoDB host: ${config.mongodb.host}`);
  logger.info(`MinIO endpoint: ${config.minio.endpoint}:${config.minio.port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  scheduledTask.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  scheduledTask.stop();
  process.exit(0);
});

module.exports = app;
