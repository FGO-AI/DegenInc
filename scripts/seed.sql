-- Local development seed. Idempotent: safe to re-run.
-- Applied with `npm run db:seed`.
--
-- Times are Unix milliseconds. 1767225600000 = 2026-01-01T00:00:00Z.

DELETE FROM order_items;
DELETE FROM orders;
DELETE FROM votes;
DELETE FROM certificates;
DELETE FROM product_images;
DELETE FROM variants;
DELETE FROM products;
DELETE FROM filings;
DELETE FROM submissions;

-- Certificate numbering starts at 0; the first issue takes number 1.
INSERT INTO counters (name, value) VALUES ('certificate', 0)
  ON CONFLICT(name) DO UPDATE SET value = 0;

INSERT INTO filings (id, number, title, status, member_preview_at, published_at, created_at, updated_at)
VALUES ('fil_001', 1, 'Filing 001', 'live', 1767052800000, 1767225600000, 1767052800000, 1767052800000);

INSERT INTO products (id, filing_id, slug, name, kind, description, price_cents, position, created_at, updated_at) VALUES
  ('prd_01','fil_001','against-the-grain-tee','Against The Grain','Tee','Heavyweight cotton, discharge print.',4500,0,1767052800000,1767052800000),
  ('prd_02','fil_001','on-fitting-in-tee','On Fitting In','Tee','The charter, printed on the back.',4500,1,1767052800000,1767052800000),
  ('prd_03','fil_001','void-stamp-hood','Void Stamp','Hood','Heavyweight fleece, embroidered seal.',9000,2,1767052800000,1767052800000);

-- One deliberately scarce variant: SKU DGN-001-M-BLK has stock 1.
-- The concurrency test in scripts/concurrent-checkout.mjs buys it twice and
-- expects exactly one failure on variants_stock_non_negative.
INSERT INTO variants (id, product_id, size, color, sku, stock, created_at, updated_at) VALUES
  ('var_01','prd_01','S','Black','DGN-001-S-BLK',12,1767052800000,1767052800000),
  ('var_02','prd_01','M','Black','DGN-001-M-BLK',1,1767052800000,1767052800000),
  ('var_03','prd_01','L','Black','DGN-001-L-BLK',8,1767052800000,1767052800000),
  ('var_04','prd_02','M','Bone','DGN-002-M-BON',6,1767052800000,1767052800000),
  ('var_05','prd_03','L','Black','DGN-003-L-BLK',4,1767052800000,1767052800000);

INSERT INTO submissions (id, name, contact, work_url, note, status, created_at) VALUES
  ('sub_01','KEROSENE','@kerosene','https://example.com/kerosene','Flash sheet, twelve designs.','new',1767052800000);
