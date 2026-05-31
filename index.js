require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

async function initDb() {
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

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

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