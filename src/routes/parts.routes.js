const express = require('express');
const router = express.Router();
const pool = require('../../db');

// GET /api/part-categories
router.get('/categories', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM part_categories ORDER BY id DESC');
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/part-categories
router.post('/categories', async (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = await pool.query(
      'INSERT INTO part_categories (name, description) VALUES ($1, $2) RETURNING *',
      [name, description || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/parts
router.get('/', async (req, res) => {
  try {
    const { categoryId, warehouseId } = req.query;
    let sql = `
      SELECT p.*, 
        COALESCE(json_agg(DISTINCT pc.name) FILTER (WHERE pc.id IS NOT NULL), '[]') AS categories,
        COALESCE(SUM(ps.quantity), 0) AS total_stock
      FROM parts p
      LEFT JOIN part_category_map pcm ON pcm.part_id = p.id
      LEFT JOIN part_categories pc ON pc.id = pcm.category_id
      LEFT JOIN part_stock ps ON ps.part_id = p.id
      ${warehouseId ? 'AND ps.warehouse_id = $1' : ''}
      ${categoryId ? (warehouseId ? 'WHERE pcm.category_id = $2' : 'WHERE pcm.category_id = $1') : ''}
      GROUP BY p.id
      ORDER BY p.id DESC
    `;
    const params = [];
    if (warehouseId) params.push(warehouseId);
    if (categoryId) params.push(categoryId);
    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/parts/:id
router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', pc.id, 'name', pc.name)) FILTER (WHERE pc.id IS NOT NULL), '[]') AS categories,
        COALESCE(json_agg(DISTINCT jsonb_build_object('warehouse_id', ps.warehouse_id, 'quantity', ps.quantity, 'min_stock', ps.min_stock)) FILTER (WHERE ps.id IS NOT NULL), '[]') AS stock
       FROM parts p
       LEFT JOIN part_category_map pcm ON pcm.part_id = p.id
       LEFT JOIN part_categories pc ON pc.id = pcm.category_id
       LEFT JOIN part_stock ps ON ps.part_id = p.id
       WHERE p.id = $1
       GROUP BY p.id`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/parts
router.post('/', async (req, res) => {
  try {
    const { sku, name, description, photo_url, category_ids } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const result = await pool.query(
      'INSERT INTO parts (sku, name, description, photo_url) VALUES ($1, $2, $3, $4) RETURNING *',
      [sku || null, name, description || null, photo_url || null]
    );
    const part = result.rows[0];
    if (category_ids && category_ids.length) {
      for (const cid of category_ids) {
        await pool.query('INSERT INTO part_category_map (part_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [part.id, cid]);
      }
    }
    res.status(201).json(part);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/parts/:id/stock
router.patch('/:id/stock', async (req, res) => {
  try {
    const { warehouse_id, quantity, min_stock } = req.body;
    if (!warehouse_id) return res.status(400).json({ error: 'warehouse_id is required' });
    const result = await pool.query(
      `INSERT INTO part_stock (part_id, warehouse_id, quantity, min_stock)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (part_id, warehouse_id) DO UPDATE
       SET quantity = EXCLUDED.quantity, min_stock = EXCLUDED.min_stock
       RETURNING *`,
      [req.params.id, warehouse_id, quantity ?? 0, min_stock ?? 0]
    );
    res.json(result.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
