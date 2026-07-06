// =============================================================================
// Product Catalog Seed Script
// Run against mongos after sharding-init.js has completed.
// Inserts NITTE merchandise products into the nitte_merch.products collection.
// Idempotent: skips insertion if products already exist.
// =============================================================================

db = db.getSiblingDB('nitte_merch');

const existingCount = db.products.countDocuments({});
if (existingCount > 0) {
  print('✓ Products already seeded (' + existingCount + ' found) — skipping.');
  quit(0);
}

print('Seeding product catalog...');

const now = new Date();

const products = [
  {
    name: 'NITTE T-Shirt',
    description: 'Official NITTE University merchandise t-shirt. Premium cotton, comfortable fit with the NITTE logo.',
    category: 'clothing',
    price: 499,
    stock: 150,
    image_url: '/api/v1/upload/images/nitte-products/nitte-tshirt.png',
    merchant_id: 'nitte-official-store',
    created_by: 'system-seed',
    created_at: now,
    updated_at: now
  },
  {
    name: 'NITTE Hoodie',
    description: 'Warm and stylish NITTE hoodie. Fleece-lined with embroidered university crest on the chest.',
    category: 'clothing',
    price: 1299,
    stock: 80,
    image_url: '/api/v1/upload/images/nitte-products/nitte-hoodie.png',
    merchant_id: 'nitte-official-store',
    created_by: 'system-seed',
    created_at: now,
    updated_at: now
  },
  {
    name: 'NITTE Premium Hoodie',
    description: 'Premium quality NITTE hoodie with zip closure. Heavy-weight fabric, perfect for winter.',
    category: 'clothing',
    price: 1799,
    stock: 50,
    image_url: '/api/v1/upload/images/nitte-products/nitte-premium_hoodie.png',
    merchant_id: 'nitte-official-store',
    created_by: 'system-seed',
    created_at: now,
    updated_at: now
  },
  {
    name: 'NITTE Cap',
    description: 'Adjustable baseball cap with NITTE embroidery. One size fits all.',
    category: 'accessories',
    price: 349,
    stock: 200,
    image_url: '/api/v1/upload/images/nitte-products/nitte-cap.png',
    merchant_id: 'nitte-official-store',
    created_by: 'system-seed',
    created_at: now,
    updated_at: now
  },
  {
    name: 'NITTE Coffee Mug',
    description: 'Ceramic coffee mug with NITTE university logo. Microwave and dishwasher safe. 350ml capacity.',
    category: 'accessories',
    price: 299,
    stock: 300,
    image_url: '/api/v1/upload/images/nitte-products/nitte-mug.png',
    merchant_id: 'nitte-official-store',
    created_by: 'system-seed',
    created_at: now,
    updated_at: now
  },
  {
    name: 'NITTE Water Bottle',
    description: 'Stainless steel insulated water bottle with NITTE branding. Keeps drinks cold for 24h, hot for 12h. 750ml.',
    category: 'accessories',
    price: 599,
    stock: 120,
    image_url: '/api/v1/upload/images/nitte-products/nitte-waterbottle.png',
    merchant_id: 'nitte-official-store',
    created_by: 'system-seed',
    created_at: now,
    updated_at: now
  },
  {
    name: 'NITTE Notebook',
    description: 'A5 hardcover notebook with NITTE cover design. 200 ruled pages, lay-flat binding.',
    category: 'stationery',
    price: 249,
    stock: 250,
    image_url: '/api/v1/upload/images/nitte-products/nitte-notebook.png',
    merchant_id: 'nitte-official-store',
    created_by: 'system-seed',
    created_at: now,
    updated_at: now
  },
  {
    name: 'NITTE Laptop Stickers',
    description: 'Pack of 5 premium vinyl stickers featuring NITTE university logos and mascots. Waterproof and UV-resistant.',
    category: 'stationery',
    price: 149,
    stock: 500,
    image_url: '/api/v1/upload/images/nitte-products/nitte-laptopStickers.png',
    merchant_id: 'nitte-official-store',
    created_by: 'system-seed',
    created_at: now,
    updated_at: now
  }
];

const result = db.products.insertMany(products);
print('✓ Seeded ' + Object.keys(result.insertedIds).length + ' products into nitte_merch.products');

// List what was inserted
products.forEach((p, i) => {
  print('  - ' + p.name + ' (₹' + p.price + ', stock: ' + p.stock + ')');
});

print('');
print('NOTE: Product images reference /api/v1/upload/images/nitte-products/<filename>');
print('      Images must be uploaded to MinIO bucket "nitte-products" for URLs to work.');
print('      Use the seed-images init container or upload manually via MinIO console.');
