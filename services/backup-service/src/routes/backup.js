const express = require('express');
const router = express.Router();
const { performBackup, listBackups, getLastBackupStatus } = require('../services/backupService');
const metrics = require('../metrics');
const config = require('../config');
const logger = require('../logger');

// POST /api/v1/backup/trigger — trigger immediate backup
router.post('/api/v1/backup/trigger', async (req, res) => {
  try {
    logger.info('Manual backup triggered via API');
    const result = await performBackup(metrics);
    res.json({
      success: true,
      data: result,
      message: 'Backup completed successfully',
    });
  } catch (error) {
    logger.error('Manual backup trigger failed', { error: error.message });
    res.status(500).json({
      success: false,
      data: null,
      message: `Backup failed: ${error.message}`,
    });
  }
});

// GET /api/v1/backup/list — list all backups
router.get('/api/v1/backup/list', async (req, res) => {
  try {
    const backups = await listBackups();
    res.json({
      success: true,
      data: backups,
      message: `Found ${backups.length} backup(s)`,
    });
  } catch (error) {
    logger.error('Failed to list backups', { error: error.message });
    res.status(500).json({
      success: false,
      data: null,
      message: `Failed to list backups: ${error.message}`,
    });
  }
});

// GET /api/v1/backup/status — last backup status
router.get('/api/v1/backup/status', (req, res) => {
  const status = getLastBackupStatus();
  res.json({
    success: true,
    data: status,
    message: status.status === 'none' ? 'No backups performed yet' : `Last backup: ${status.status}`,
  });
});

// GET /health — health check
router.get('/health', (req, res) => {
  const status = getLastBackupStatus();
  res.json({
    success: true,
    data: {
      status: 'healthy',
      uptime: process.uptime(),
      schedule: config.backup.schedule,
      lastRun: status.timestamp,
      lastStatus: status.status,
    },
    message: 'Service is healthy',
  });
});

// GET /metrics — Prometheus metrics
router.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  } catch (error) {
    logger.error('Failed to generate metrics', { error: error.message });
    res.status(500).end();
  }
});

module.exports = router;
