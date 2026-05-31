const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');

async function main() {
  const file = process.argv[2];
  if (!file) {
    throw new Error('Usage: node src/sql/runSqlFile.js <sql-file>');
  }

  const fullPath = path.resolve(file);
  const sql = fs.readFileSync(fullPath, 'utf8');
  await pool.query(sql);
  console.log(`Applied: ${fullPath}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
