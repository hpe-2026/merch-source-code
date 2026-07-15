module.exports = {
  mongodb: {
    host: process.env.MONGODB_HOST || 'mongodb:27017',
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || '192.168.56.10',
    port: parseInt(process.env.MINIO_PORT || '30900', 10),
    accessKey: process.env.MINIO_ACCESS_KEY || 'app-user',
    secretKey: process.env.MINIO_SECRET_KEY || 'AppStorage99!',
    bucket: process.env.MINIO_BUCKET || 'nitte-backups',
    useSSL: false,
  },
  backup: {
    schedule: process.env.BACKUP_SCHEDULE || '0 2 * * *',
    retentionCount: 7,
    prefix: 'mongodb/',
    tempPath: '/tmp/backup.gz',
  },
  port: parseInt(process.env.PORT || '9200', 10),
};
