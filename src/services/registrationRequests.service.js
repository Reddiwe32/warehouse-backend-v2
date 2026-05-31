const bcrypt = require('bcryptjs');
const pool = require('../../db');
const HttpError = require('../utils/httpError');

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '').trim();
}

async function create({ phone, fullName, password }) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone || !fullName || !password) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'phone, fullName and password are required');
  }

  if (String(password).length < 4) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'password is too short');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const { rows } = await pool.query(
      `INSERT INTO registration_requests (phone, fullname, password, status, createdat)
       VALUES ($1, $2, $3, 'PENDING', NOW())
       RETURNING id, phone, fullname, status, createdat`,
      [normalizedPhone, String(fullName).trim(), passwordHash]
    );

    return {
      id: rows[0].id,
      phone: rows[0].phone,
      fullName: rows[0].fullname,
      status: rows[0].status,
      createdAt: rows[0].createdat,
    };
  } catch (err) {
    if (err.code === '23505') {
      throw new HttpError(409, 'REGISTRATION_REQUEST_EXISTS', 'pending request already exists for this phone');
    }
    throw err;
  }
}

async function list({ status }) {
  const params = [];
  let sql = `
    SELECT
      rr.id,
      rr.phone,
      rr.fullname,
      rr.status,
      COALESCE(rr.requested_role, rr.role) AS requested_role,
      COALESCE(rr.warehouse_id, rr.warehouseid) AS warehouse_id,
      rr.comment,
      rr.reviewed_by,
      rr.reviewed_at,
      rr.createdat,
      rr.updated_at,
      w.name AS warehouse_name
    FROM registration_requests rr
    LEFT JOIN warehouses w
      ON w.id = COALESCE(rr.warehouse_id, rr.warehouseid)
  `;

  if (status) {
    params.push(String(status).toUpperCase());
    sql += ` WHERE rr.status = $${params.length}`;
  }

  sql += ` ORDER BY rr.createdat DESC`;

  const { rows } = await pool.query(sql, params);

  return rows.map((r) => ({
    id: r.id,
    phone: r.phone,
    fullName: r.fullname,
    status: r.status,
    requestedRole: r.requested_role,
    warehouseId: r.warehouse_id,
    comment: r.comment,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdAt: r.createdat,
    updatedAt: r.updated_at,
    warehouseName: r.warehouse_name,
  }));
}

async function approve(id, body, actor) {
  if (!Number.isFinite(id)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'invalid registration request id');
  }

  const role = body?.role ? String(body.role).trim() : null;
  const warehouseId = body?.warehouseId ?? null;
  const warehouseIds = Array.isArray(body?.warehouseIds) ? body.warehouseIds : [];

  if (!role) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'role is required');
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const rrRes = await client.query(
      `SELECT *
       FROM registration_requests
       WHERE id = $1
       FOR UPDATE`,
      [id]
    );

    if (!rrRes.rows.length) {
      throw new HttpError(404, 'NOT_FOUND', 'registration request not found');
    }

    const request = rrRes.rows[0];

    if (String(request.status).toUpperCase() !== 'PENDING') {
      throw new HttpError(409, 'INVALID_STATUS', 'registration request is not pending');
    }

    const requestPhone = request.phone;
    const requestFullName = request.fullname;
    const requestPassword = request.password;

    const existingUserRes = await client.query(
      `SELECT id FROM users WHERE phone = $1 OR login = $1 LIMIT 1`,
      [requestPhone]
    );

    if (existingUserRes.rows.length) {
      throw new HttpError(409, 'USER_ALREADY_EXISTS', 'user with this phone already exists');
    }

    const userInsertRes = await client.query(
      `INSERT INTO users (login, password, full_name, role, warehouse_id, is_admin, is_active, phone)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7)
       RETURNING id, login, full_name, role, warehouse_id, is_admin, is_active, phone, created_at`,
      [
        requestPhone,
        requestPassword,
        requestFullName,
        role,
        warehouseId,
        role === 'SUPER_ADMIN',
        requestPhone,
      ]
    );

    const user = userInsertRes.rows[0];

    const uniqueWarehouseIds = [...new Set(
      warehouseIds.map(Number).filter(Number.isFinite)
    )];

    const hasUserWarehousesTable = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_name = 'user_warehouses'
      ) AS exists
    `);

    if (hasUserWarehousesTable.rows[0]?.exists) {
      for (const wid of uniqueWarehouseIds) {
        const hasLegacyColumns = await client.query(`
          SELECT COUNT(*)::int AS cnt
          FROM information_schema.columns
          WHERE table_name = 'user_warehouses'
            AND column_name IN ('userid', 'warehouseid')
        `);

        if (hasLegacyColumns.rows[0]?.cnt === 2) {
          await client.query(
            `INSERT INTO user_warehouses (userid, warehouseid)
             SELECT $1, $2
             WHERE NOT EXISTS (
               SELECT 1 FROM user_warehouses
               WHERE userid = $1 AND warehouseid = $2
             )`,
            [user.id, wid]
          );
        } else {
          await client.query(
            `INSERT INTO user_warehouses (user_id, warehouse_id)
             VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [user.id, wid]
          );
        }
      }
    }

    await client.query(
      `UPDATE registration_requests
       SET status = 'APPROVED',
           role = $2,
           warehouseid = COALESCE($3, warehouseid),
           requested_role = $2,
           warehouse_id = $3,
           reviewed_by = $4,
           reviewed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1`,
      [id, role, warehouseId, actor?.id || null]
    );

    await client.query('COMMIT');

    return {
      userId: user.id,
      registrationRequestId: id,
      status: 'APPROVED',
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function reject(id, body, actor) {
  if (!Number.isFinite(id)) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'invalid registration request id');
  }

  const reason = body?.reason ? String(body.reason).trim() : null;

  const { rowCount } = await pool.query(
    `UPDATE registration_requests
     SET status = 'REJECTED',
         comment = COALESCE($2, comment),
         reviewed_by = $3,
         reviewed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND UPPER(status) = 'PENDING'`,
    [id, reason, actor?.id || null]
  );

  if (!rowCount) {
    throw new HttpError(404, 'NOT_FOUND_OR_NOT_PENDING', 'pending registration request not found');
  }

  return {
    registrationRequestId: id,
    status: 'REJECTED',
  };
}

module.exports = {
  create,
  list,
  approve,
  reject,
};
