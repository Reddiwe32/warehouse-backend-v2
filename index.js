require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const app = express();
const registrationRequestsRoutes = require('./src/routes/registrationRequests.routes');
const notificationsRoutes = require('./src/routes/notifications.routes');
const errorHandler = require('./src/middlewares/errorHandler');
const multer = require('multer');
const nodePath = require('path');
const nodeFs = require('fs');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const uploadsDir = nodePath.join(__dirname, 'uploads');
if (!nodeFs.existsSync(uploadsDir)) nodeFs.mkdirSync(uploadsDir);

const useCloudinary = !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
console.log('[INIT] useCloudinary=' + useCloudinary);

const storage = useCloudinary
  ? new CloudinaryStorage({
      cloudinary,
      params: { folder: 'warehouse', allowed_formats: ['jpg','jpeg','png','gif','webp'] },
    })
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, uploadsDir),
      filename: (req, file, cb) => {
        const ext = nodePath.extname(file.originalname);
        cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
      }
    });

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ok = allowed.test(nodePath.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype);
    ok ? cb(null, true) : cb(new Error('Tolko izobrazheniya'));
  }
});


app.use(cors());
app.use(express.json());

app.use('/api/registration-requests', registrationRequestsRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/uploads', express.static(uploadsDir));

app.post('/api/upload', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File not provided' });
  console.log('[UPLOAD] useCloudinary=' + useCloudinary + ' keys=' + Object.keys(req.file).join(','));
  const url = req.file.path || (req.protocol + '://' + req.get('host') + '/uploads/' + req.file.filename);
  console.log('[UPLOAD] url=' + url);
  res.json({ url, filename: req.file.filename || req.file.originalname });
});


async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS part_categories (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS parts (id BIGSERIAL PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, description TEXT, photo_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS part_category_map (part_id BIGINT REFERENCES parts(id) ON DELETE CASCADE, category_id BIGINT REFERENCES part_categories(id) ON DELETE CASCADE, PRIMARY KEY (part_id, category_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS part_stock (id BIGSERIAL PRIMARY KEY, part_id BIGINT REFERENCES parts(id) ON DELETE CASCADE, warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE CASCADE, quantity INT NOT NULL DEFAULT 0, min_stock INT NOT NULL DEFAULT 0, UNIQUE (part_id, warehouse_id));`);

  await pool.query(`CREATE TABLE IF NOT EXISTS part_categories (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS parts (id BIGSERIAL PRIMARY KEY, sku TEXT UNIQUE, name TEXT NOT NULL, description TEXT, photo_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS part_category_map (part_id BIGINT REFERENCES parts(id) ON DELETE CASCADE, category_id BIGINT REFERENCES part_categories(id) ON DELETE CASCADE, PRIMARY KEY (part_id, category_id));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS part_stock (id BIGSERIAL PRIMARY KEY, part_id BIGINT REFERENCES parts(id) ON DELETE CASCADE, warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE CASCADE, quantity INT NOT NULL DEFAULT 0, min_stock INT NOT NULL DEFAULT 0, UNIQUE (part_id, warehouse_id));`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      login TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      warehouse_id INTEGER,
      is_admin BOOLEAN NOT NULL DEFAULT false,
      is_active BOOLEAN NOT NULL DEFAULT true,
      fcm_token TEXT,
      phone TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS warehouses (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS locations (
      id BIGSERIAL PRIMARY KEY,
      warehouse_id BIGINT REFERENCES warehouses(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS repair_requests (
      id BIGSERIAL PRIMARY KEY,
      location_id BIGINT REFERENCES locations(id) ON DELETE SET NULL,
      carriage_number TEXT,
      breakdown_type_id BIGINT,
      comment TEXT,
      urgency TEXT NOT NULL DEFAULT 'NORMAL',
      status TEXT NOT NULL DEFAULT 'NEW',
      created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      assigned_to_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
      complexity TEXT NOT NULL DEFAULT 'LIGHT',
      taken_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    if (!token) {
      return res.status(401).json({ error: 'Token required' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'warehouse-backend-v2', root: true });
});

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() as now');
    res.json({
      ok: true,
      service: 'warehouse-backend-v2',
      db: 'connected',
      time: result.rows[0].now,
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      ok: false,
      service: 'warehouse-backend-v2',
      db: 'error',
      error: error.message,
    });
  }
});

app.get('/api/users', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, login, full_name, role, warehouse_id, created_at
      FROM users
      ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('GET /api/users error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/users', async (req, res) => {
  try {
    const { login, password, full_name, role, warehouse_id } = req.body;

    if (!login || !password || !full_name) {
      return res.status(400).json({
        error: 'login, password, full_name are required',
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `
      INSERT INTO users (login, password, full_name, role, warehouse_id, is_admin, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, login, full_name, role, warehouse_id, created_at
      `,
      [
        login,
        passwordHash,
        full_name,
        role || 'user',
        warehouse_id || null,
        role === 'SUPER_ADMIN',
        true
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('POST /api/users error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { login, password } = req.body;

    if (!login || !password) {
      return res.status(400).json({ error: 'login and password are required' });
    }

    const result = await pool.query(
      `
      SELECT id, login, password, full_name, role, warehouse_id, is_active
      FROM users
      WHERE login = $1
      LIMIT 1
      `,
      [login]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'User is inactive' });
    }

    const ok = await bcrypt.compare(password, user.password);

    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      {
        id: user.id,
        login: user.login,
        role: user.role,
        warehouse_id: user.warehouse_id,
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        login: user.login,
        full_name: user.full_name,
        role: user.role,
        warehouse_id: user.warehouse_id,
      },
    });
  } catch (error) {
    console.error('POST /api/auth/login error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/users/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, login, full_name, role, warehouse_id, created_at FROM users WHERE id = $1 LIMIT 1',
      [req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/me', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT id, login, full_name, role, warehouse_id, created_at
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('GET /api/me error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/warehouses', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, name, address, created_at
      FROM warehouses
      ORDER BY id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('GET /api/warehouses error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/warehouses', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const { name, address } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const result = await pool.query(
      `
      INSERT INTO warehouses (name, address)
      VALUES ($1, $2)
      RETURNING id, name, address, created_at
      `,
      [name, address || null]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('POST /api/warehouses error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/locations', authMiddleware, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.id, l.name, l.warehouse_id, w.name AS warehouse_name, l.created_at
      FROM locations l
      LEFT JOIN warehouses w ON w.id = l.warehouse_id
      ORDER BY l.id DESC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('GET /api/locations error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/locations', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res) => {
  try {
    const { name, warehouse_id } = req.body;

    if (!name || !warehouse_id) {
      return res.status(400).json({ error: 'name and warehouse_id are required' });
    }

    const result = await pool.query(
      `
      INSERT INTO locations (name, warehouse_id)
      VALUES ($1, $2)
      RETURNING id, name, warehouse_id, created_at
      `,
      [name, warehouse_id]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('POST /api/locations error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/repairs', authMiddleware, async (req, res) => {
  try {
    const { status, urgency, locationId } = req.query;

    const conditions = [];
    const params = [];

    if (status) {
      params.push(status);
      conditions.push(`r.status = $${params.length}`);
    }

    if (urgency) {
      params.push(urgency);
      conditions.push(`r.urgency = $${params.length}`);
    }

    if (locationId) {
      params.push(locationId);
      conditions.push(`r.location_id = $${params.length}`);
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const result = await pool.query(
      `
      SELECT
        r.id,
        r.urgency,
        r.location_id,
        r.carriage_number,
        r.breakdown_type_id,
        r.comment,
        r.status,
        r.created_by_user_id,
        r.assigned_to_user_id,
        r.created_at,
        r.updated_at,
        r.started_at,
        r.closed_at,
        r.completed_at,
        r.complexity,
        r.taken_at,
        l.name AS location_name,
        cu.full_name AS created_by_name,
        au.full_name AS assigned_to_name
      FROM repair_requests r
      LEFT JOIN locations l ON l.id = r.location_id
      LEFT JOIN users cu ON cu.id = r.created_by_user_id
      LEFT JOIN users au ON au.id = r.assigned_to_user_id
      ${whereSql}
      ORDER BY
        CASE WHEN r.urgency = 'URGENT' THEN 0 ELSE 1 END,
        r.created_at DESC
      `,
      params
    );

    res.json(result.rows);
  } catch (error) {
    console.error('GET /api/repairs error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/repairs', authMiddleware, async (req, res) => {
  try {
    const {
      locationId,
      carriageNumber,
      breakdownTypeId,
      comment,
      urgency,
      assignedToUserId,
      complexity,
    } = req.body;

    if (!locationId || !carriageNumber) {
      return res.status(400).json({ error: 'locationId and carriageNumber are required' });
    }

    const result = await pool.query(
      `
      INSERT INTO repair_requests (
        location_id,
        carriage_number,
        breakdown_type_id,
        comment,
        urgency,
        status,
        created_by_user_id,
        assigned_to_user_id,
        complexity,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, 'NEW', $6, $7, $8, NOW(), NOW())
      RETURNING
        id,
        urgency,
        location_id,
        carriage_number,
        breakdown_type_id,
        comment,
        status,
        created_by_user_id,
        assigned_to_user_id,
        created_at,
        updated_at,
        complexity
      `,
      [
        locationId,
        carriageNumber,
        breakdownTypeId || null,
        comment || null,
        urgency || 'NORMAL',
        req.user.id,
        assignedToUserId || null,
        complexity || 'LIGHT',
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('POST /api/repairs error:', error);
    res.status(500).json({ error: error.message });
  }
});

const partsRoutes = require('./src/routes/parts.routes');
app.use('/api/parts', authMiddleware, partsRoutes);

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

console.log('PORT from env =', process.env.PORT);


app.get('/api/my/locations', authMiddleware, async (req, res) => {
  try {
    const warehouseId = req.user.warehouse_id;
    if (!warehouseId) return res.json([]);
    const result = await pool.query(
      'SELECT id, name, warehouse_id, created_at FROM locations WHERE warehouse_id = $1 ORDER BY name ASC',
      [warehouseId]
    );
    res.json(result.rows);
  } catch (e) {
    console.error('GET /api/my/locations error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.use(errorHandler);

initDb()
  .then(() => {
app.listen(PORT, HOST, () => {
      console.log(`API started on http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error('Database init error:', error);
    process.exit(1);
  });
// ─── PART CATEGORIES ────────────────────────────────────────
app.get('/api/parts/categories', authMiddleware, async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT id, name, description, parent_id, created_at, updated_at FROM part_categories ORDER BY name ASC`);
    res.json({ success: true, data: rows });
  } catch (e) { next(e); }
});

app.post('/api/parts/categories', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const parentId = req.body && req.body.parentId ? Number(req.body.parentId) : null;
    if (!name) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
    const { rows } = await pool.query(
      `INSERT INTO part_categories (name, description, parent_id) VALUES ($1, $2, $3) RETURNING id, name, description, parent_id, created_at, updated_at`,
      [name, description, parentId]
    );
    res.status(201).json({ success: true, data: rows[0] });
  } catch (e) { next(e); }
});

app.put('/api/parts/categories/:id', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    const description = req.body?.description ? String(req.body.description).trim() : null;
    if (!name) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
    const { rows } = await pool.query(
      `UPDATE part_categories SET name=$1, description=$2, updated_at=NOW() WHERE id=$3 RETURNING id, name, description, created_at, updated_at`,
      [name, description, id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'category not found' } });
    res.json({ success: true, data: rows[0] });
  } catch (e) { next(e); }
});

app.delete('/api/parts/categories/:id', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM part_categories WHERE id=$1', [Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'category not found' } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ─── PARTS ──────────────────────────────────────────────────
app.get('/api/parts', authMiddleware, async (req, res, next) => {
  try {
    const role = req.user.role;
    const userId = req.user.id;
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
    const params = [];
    const conditions = [];
    if (categoryId) {
      params.push(categoryId);
      conditions.push(`p.id IN (SELECT part_id FROM part_category_map WHERE category_id = $${params.length})`);
    }
    if (role === 'SCOUT' || role === 'SCOUT_FULL') {
      params.push(userId);
      conditions.push(`p.id IN (SELECT ps.part_id FROM part_stock ps JOIN user_warehouses uw ON uw.warehouseid = ps.warehouse_id WHERE uw.userid = $${params.length} AND ps.quantity > 0)`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await pool.query(`
      SELECT p.id, p.sku, p.name, p.description, p.photo_url, p.created_at, p.updated_at,
        COALESCE(json_agg(DISTINCT jsonb_build_object('id', pc.id, 'name', pc.name)) FILTER (WHERE pc.id IS NOT NULL), '[]') AS categories
      FROM parts p
      LEFT JOIN part_category_map pcm ON pcm.part_id = p.id
      LEFT JOIN part_categories pc ON pc.id = pcm.category_id
      ${where} GROUP BY p.id ORDER BY p.name ASC`, params);
    res.json({ success: true, data: rows });
  } catch (e) { next(e); }
});

app.post('/api/parts', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
    const description = req.body?.description ? String(req.body.description).trim() : null;
    const photo_url = req.body?.photo_url ? String(req.body.photo_url).trim() : null;
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds.map(Number) : [];
    const { rows } = await client.query(
      `INSERT INTO parts (name, description, photo_url) VALUES ($1, $2, $3) RETURNING id, name, description, photo_url, created_at, updated_at`,
      [name, description, photo_url]
    );
    const part = rows[0];
    const sku = 'PART-' + String(part.id).padStart(6, '0');
    await client.query('UPDATE parts SET sku=$1 WHERE id=$2', [sku, part.id]);
    part.sku = sku;
    for (const cid of categoryIds) {
      await client.query(`INSERT INTO part_category_map (part_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [part.id, cid]);
    }
    await client.query('COMMIT');
    res.status(201).json({ success: true, data: { ...part, sku } });
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

app.put('/api/parts/:id', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const id = Number(req.params.id);
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
    const description = req.body?.description !== undefined ? (req.body.description || null) : undefined;
    const photo_url = req.body?.photo_url !== undefined ? (req.body.photo_url || null) : undefined;
    const categoryIds = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds.map(Number) : null;
    const { rows } = await client.query(
      `UPDATE parts SET name=$1, description=COALESCE($2, description), photo_url=COALESCE($3, photo_url), updated_at=NOW()
       WHERE id=$4 RETURNING id, sku, name, description, photo_url, created_at, updated_at`,
      [name, description ?? null, photo_url ?? null, id]
    );
    if (!rows.length) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'part not found' } });
    if (categoryIds !== null) {
      await client.query('DELETE FROM part_category_map WHERE part_id=$1', [id]);
      for (const cid of categoryIds) {
        await client.query(`INSERT INTO part_category_map (part_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, cid]);
      }
    }
    await client.query('COMMIT');
    res.json({ success: true, data: rows[0] });
  } catch (e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

app.delete('/api/parts/:id', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const { rowCount } = await pool.query('DELETE FROM parts WHERE id=$1', [Number(req.params.id)]);
    if (!rowCount) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'part not found' } });
    res.json({ success: true });
  } catch (e) { next(e); }
});

// ─── STOCK ──────────────────────────────────────────────────
app.get('/api/parts/:id/stock', authMiddleware, async (req, res, next) => {
  try {
    const partId = Number(req.params.id);
    const role = req.user.role;
    const userId = req.user.id;
    let sql = `SELECT ps.warehouse_id, ps.quantity, ps.min_stock, w.name AS warehouse_name
               FROM part_stock ps JOIN warehouses w ON w.id = ps.warehouse_id WHERE ps.part_id = $1`;
    const params = [partId];
    if (['TECHNICIAN','SENIOR_TECH','SCOUT','SCOUT_FULL'].includes(role)) {
      params.push(userId);
      sql += ` AND ps.warehouse_id IN (SELECT warehouseid FROM user_warehouses WHERE userid = $2)`;
    }
    const { rows } = await pool.query(sql + ' ORDER BY w.name ASC', params);
    res.json({ success: true, data: rows });
  } catch (e) { next(e); }
});

app.put('/api/parts/:id/stock', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    const partId = Number(req.params.id);
    const warehouseId = Number(req.body?.warehouseId);
    const quantity = Number(req.body?.quantity ?? 0);
    const min_stock = Number(req.body?.minStock ?? 0);
    if (!warehouseId) return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'warehouseId is required' } });
    const { rows } = await pool.query(
      `INSERT INTO part_stock (part_id, warehouse_id, quantity, min_stock) VALUES ($1, $2, $3, $4)
       ON CONFLICT (part_id, warehouse_id) DO UPDATE SET quantity=$3, min_stock=$4 RETURNING *`,
      [partId, warehouseId, quantity, min_stock]
    );
    res.json({ success: true, data: rows[0] });
  } catch (e) { next(e); }
});

// ─── МИГРАЦИЯ: добавить parent_id в part_categories ─────────
app.post('/api/migrations/add-category-parent', authMiddleware, requireRole('SUPER_ADMIN'), async (req, res, next) => {
  try {
    await pool.query(`ALTER TABLE part_categories ADD COLUMN IF NOT EXISTS parent_id BIGINT REFERENCES part_categories(id) ON DELETE CASCADE`);
    res.json({ success: true, message: 'parent_id added' });
  } catch (e) { next(e); }
});
