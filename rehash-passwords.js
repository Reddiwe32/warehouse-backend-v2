require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

(async () => {
  try {
    const result = await pool.query(`
      SELECT id, login, password
      FROM users
      ORDER BY id
    `);

    for (const user of result.rows) {
      const pwd = user.password || '';

      if (pwd.startsWith('$2a$') || pwd.startsWith('$2b$') || pwd.startsWith('$2y$')) {
        console.log(`skip hashed user ${user.id} ${user.login}`);
        continue;
      }

      const hash = await bcrypt.hash(pwd, 12);

      await pool.query(
        `UPDATE users SET password = $1 WHERE id = $2`,
        [hash, user.id]
      );

      console.log(`hashed user ${user.id} ${user.login}`);
    }

    console.log('done');
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
