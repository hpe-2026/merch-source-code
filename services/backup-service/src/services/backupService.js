const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const Minio = require('minio');
const config = require('../config');
const logger = require('../logger');

const minioClient = new Minio.Client({
  endPoint: config.minio.endpoint,
  port: config.minio.port,
  useSSL: config.minio.useSSL,
  accessKey: config.minio.accessKey,
  secretKey: config.minio.secretKey,
});

let lastBackup = {
  timestamp: null,
  status: 'none',
  size: 0,
  duration: 0,
  error: null,
};

function getLastBackupStatus() {
  return { ...lastBackup };
}

async function ensureBucket() {
  const exists = await minioClient.bucketExists(config.minio.bucket);
  if (!exists) {
    await minioClient.makeBucket(config.minio.bucket, '');
    logger.info(`Created bucket: ${config.minio.bucket}`);
  }
}

function runMongoDump() {
  return new Promise((resolve, reject) => {
    const args = [
      '--host', config.mongodb.host,
      '--gzip',
      `--archive=${config.backup.tempPath}`,
    ];

    logger.info('Starting mongodump', { host: config.mongodb.host });

    execFile('mongodump', args, (error, stdout, stderr) => {
      if (error) {
        logger.error('mongodump failed', { error: error.message, stderr });
        return reject(new Error(`mongodump failed: ${error.message}`));
      }
      logger.info('mongodump completed', { stdout, stderr });
      resolve();
    });
  });
}

async function uploadToMinio(timestamp) {
  const objectName = `${config.backup.prefix}${timestamp}.gz`;
  const filePath = config.backup.tempPath;
  const stat = fs.statSync(filePath);

  await minioClient.fPutObject(config.minio.bucket, objectName, filePath, {
    'Content-Type': 'application/gzip',
    'X-Backup-Timestamp': timestamp,
  });

  logger.info('Uploaded backup to MinIO', { objectName, size: stat.size });
  return { objectName, size: stat.size };
}

async function pruneOldBackups() {
  const prefix = config.backup.prefix;
  const objects = [];

  const stream = minioClient.listObjects(config.minio.bucket, prefix, true);

  await new Promise((resolve, reject) => {
    stream.on('data', (obj) => objects.push(obj));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  objects.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

  if (objects.length > config.backup.retentionCount) {
    const toDelete = objects.slice(config.backup.retentionCount);
    for (const obj of toDelete) {
      await minioClient.removeObject(config.minio.bucket, obj.name);
      logger.info('Pruned old backup', { name: obj.name });
    }
    logger.info(`Pruned ${toDelete.length} old backup(s)`);
  }
}

async function performBackup(metrics) {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  try {
    await ensureBucket();
    await runMongoDump();
    const { objectName, size } = await uploadToMinio(timestamp);
    await pruneOldBackups();

    const duration = (Date.now() - startTime) / 1000;

    lastBackup = {
      timestamp: new Date().toISOString(),
      status: 'success',
      size,
      duration,
      error: null,
    };

    // Update Prometheus metrics
    if (metrics) {
      metrics.backupLastSuccess.setToCurrentTime();
      metrics.backupDuration.set(duration);
      metrics.backupSize.set(size);
      metrics.backupTotal.inc({ status: 'success' });
    }

    logger.info('Backup completed successfully', { objectName, size, duration });

    // Clean up temp file
    if (fs.existsSync(config.backup.tempPath)) {
      fs.unlinkSync(config.backup.tempPath);
    }

    return lastBackup;
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;

    lastBackup = {
      timestamp: new Date().toISOString(),
      status: 'failed',
      size: 0,
      duration,
      error: error.message,
    };

    if (metrics) {
      metrics.backupDuration.set(duration);
      metrics.backupTotal.inc({ status: 'failed' });
    }

    logger.error('Backup failed', { error: error.message, duration });

    // Clean up temp file on failure
    if (fs.existsSync(config.backup.tempPath)) {
      fs.unlinkSync(config.backup.tempPath);
    }

    throw error;
  }
}

async function listBackups() {
  const prefix = config.backup.prefix;
  const objects = [];

  await ensureBucket();

  const stream = minioClient.listObjects(config.minio.bucket, prefix, true);

  await new Promise((resolve, reject) => {
    stream.on('data', (obj) => objects.push({
      name: obj.name,
      size: obj.size,
      lastModified: obj.lastModified,
    }));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  objects.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

  return objects;
}

module.exports = {
  performBackup,
  listBackups,
  getLastBackupStatus,
};
