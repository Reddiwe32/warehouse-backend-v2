const { Pool } = require('pg');

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DB_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const isRailway = /railway\.internal|rlwy\.net/.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: process.env.PGSSLMODE === 'disable'
    ? false
    : (isRailway ? { rejectUnauthorized: false } : false),
});

module.exports = pool;
