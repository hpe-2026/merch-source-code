// MongoDB Sharding Initialization Script
// Run against mongos router after all shards are added
// Sets up sharding on nitte_merch.orders by region

// Switch to admin DB
db = db.getSiblingDB('admin');

// Add shards (wait for them to be available)
print('Adding shards to cluster...');

try {
  sh.addShard('shard1/mongo-shard1:27018');
  print('✓ Shard 1 (South/West India) added');
} catch (e) {
  print('✓ Shard 1 already exists');
}

try {
  sh.addShard('shard2/mongo-shard2:27019');
  print('✓ Shard 2 (North/East India) added');
} catch (e) {
  print('✓ Shard 2 already exists');
}

// Switch to nitte_merch database
db = db.getSiblingDB('nitte_merch');

// Create application users (optional in dev — no auth enforcement without keyFile).
// In production (Kubernetes), auth is enforced via keyFile and these users are required.
// For local dev, these are created for compatibility but mongos runs without auth.
const writerPass = typeof APP_WRITER_PASS !== 'undefined' ? APP_WRITER_PASS : 'app_writer_dev';
const readerPass = typeof APP_READER_PASS !== 'undefined' ? APP_READER_PASS : 'app_reader_dev';

print('Creating application users...');
try {
  db.createUser({
    user: 'app_writer',
    pwd: writerPass,
    roles: [{ role: 'readWrite', db: 'nitte_merch' }]
  });
} catch (e) { print('app_writer may already exist'); }

try {
  db.createUser({
    user: 'app_reader',
    pwd: readerPass,
    roles: [{ role: 'read', db: 'nitte_merch' }]
  });
} catch (e) { print('app_reader may already exist'); }

// Create collections
db.createCollection('products');
db.createCollection('orders');
db.createCollection('users');

// Enable sharding on the database
db = db.getSiblingDB('admin');
try { sh.enableSharding('nitte_merch'); } catch (e) { /* already enabled */ }
print('✓ Sharding enabled on nitte_merch database');

// Shard the orders collection by region
db = db.getSiblingDB('nitte_merch');
db.orders.createIndex({ region: 1 });
db = db.getSiblingDB('admin');
try { sh.shardCollection('nitte_merch.orders', { region: 1 }); } catch (e) { /* already sharded */ }
print('✓ orders collection sharded by region');

// Create zone mappings for region-based routing
sh.addShardToZone('shard1', 'SOUTH_WEST');
sh.addShardToZone('shard2', 'NORTH_EAST');

// Define zone ranges
sh.updateZoneKeyRange(
  'nitte_merch.orders',
  { region: 'south' },
  { region: 'south~' },
  'SOUTH_WEST'
);
sh.updateZoneKeyRange(
  'nitte_merch.orders',
  { region: 'west' },
  { region: 'west~' },
  'SOUTH_WEST'
);
sh.updateZoneKeyRange(
  'nitte_merch.orders',
  { region: 'north' },
  { region: 'north~' },
  'NORTH_EAST'
);
sh.updateZoneKeyRange(
  'nitte_merch.orders',
  { region: 'east' },
  { region: 'east~' },
  'NORTH_EAST'
);

print('✓ Zone ranges configured:');
print('  - south, west → Shard 1 (SOUTH_WEST zone)');
print('  - north, east → Shard 2 (NORTH_EAST zone)');

// Create indexes for other collections
db = db.getSiblingDB('nitte_merch');
[
  () => db.products.createIndex({ name: 1 }),
  () => db.products.createIndex({ category: 1 }),
  () => db.products.createIndex({ merchant_id: 1 }),
  () => db.orders.createIndex({ user_id: 1 }),
  () => db.orders.createIndex({ merchant_id: 1 }),
  () => db.orders.createIndex({ order_id: 1 }),
  () => db.users.createIndex({ email: 1 }),
  () => db.users.createIndex({ status: 1 }),
].forEach(fn => { try { fn(); } catch (e) { print('index skip: ' + e.message); } });

// Seed all application users (idempotent — matches Keycloak realm import)
const seedUsers = [
  { email: 'admin@nitte.edu', name: 'Admin User', role: 'platform-admin', roles: ['platform-admin'], status: 'approved', user_type: 'admin' },
  { email: 'alumni@nitte.edu', name: 'Alumni User', role: 'alumni-verified', roles: ['alumni-verified'], status: 'approved', user_type: 'alumni' },
  { email: 'guest_user', name: 'Guest Demo', role: 'non_alumni', roles: ['non_alumni'], status: 'active', user_type: 'guest' },
  { email: 'merchant-admin@nitte.edu', name: 'Merchant Admin', role: 'merchant-admin', roles: ['merchant-admin'], status: 'approved', user_type: 'merchant', merchant_id: 'nitte-official-store' },
  { email: 'amazon-merchant@amazon.com', name: 'Amazon Merchant', role: 'merchant-admin', roles: ['merchant-admin'], status: 'approved', user_type: 'merchant', merchant_id: 'amazon-store' },
  { email: 'flipkart-merchant@flipkart.com', name: 'Flipkart Merchant', role: 'merchant-admin', roles: ['merchant-admin'], status: 'approved', user_type: 'merchant', merchant_id: 'flipkart-store' },
  { email: 'internal-admin@nitte.ac.in', name: 'Internal Admin', role: 'admin-internal', roles: ['admin-internal', 'keycloak-admin'], status: 'approved', user_type: 'internal' },
  { email: 'internal-user@nitte.ac.in', name: 'Internal User', role: 'internal-user', roles: ['internal-user'], status: 'approved', user_type: 'internal' }
];

let userSeeded = 0;
seedUsers.forEach(u => {
  const doc = Object.assign({}, u, {
    verified: true,
    registration_timestamp: new Date(),
    approved_by: 'system',
    approval_timestamp: new Date(),
    events: [
      { type: 'registered', timestamp: new Date(), actor: 'system', reason: 'Initial seed' },
      { type: 'approved', timestamp: new Date(), actor: 'system', reason: 'Auto-approved' }
    ]
  });
  const r = db.users.updateOne({ email: u.email }, { $setOnInsert: doc }, { upsert: true });
  if (r.upsertedCount > 0) userSeeded++;
});
print('✓ Seeded ' + userSeeded + ' users (' + (seedUsers.length - userSeeded) + ' already existed)');

print('');
print('========================================');
print('MongoDB Sharding Setup Complete!');
print('========================================');
print('Database: nitte_merch');
print('Sharded collection: orders (key: region)');
print('Shard 1 (SOUTH_WEST): south, west regions');
print('Shard 2 (NORTH_EAST): north, east regions');
print('');
print('Run sh.status() for full cluster info');
print('========================================');
