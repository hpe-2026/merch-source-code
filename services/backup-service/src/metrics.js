const promClient = require('prom-client');

// Create a Registry
const register = new promClient.Registry();

// Add default metrics
promClient.collectDefaultMetrics({ register });

// Custom backup metrics
const backupLastSuccess = new promClient.Gauge({
  name: 'backup_last_success_timestamp',
  help: 'Timestamp of the last successful backup',
  registers: [register],
});

const backupDuration = new promClient.Gauge({
  name: 'backup_duration_seconds',
  help: 'Duration of the last backup in seconds',
  registers: [register],
});

const backupSize = new promClient.Gauge({
  name: 'backup_size_bytes',
  help: 'Size of the last backup in bytes',
  registers: [register],
});

const backupTotal = new promClient.Counter({
  name: 'backup_total',
  help: 'Total number of backups attempted',
  labelNames: ['status'],
  registers: [register],
});

module.exports = {
  register,
  backupLastSuccess,
  backupDuration,
  backupSize,
  backupTotal,
};
