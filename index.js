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

app.use(cors());
app.use(express.json());

app.use('/api/registration-requests', registrationRequestsRoutes);
app.use('/api/notifications', notificationsRoutes);

async function initDb() {
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