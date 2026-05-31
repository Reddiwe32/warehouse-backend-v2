require('dotenv').config();
const bcrypt = require('bcryptjs');
const pool = require('./db');

(async () => {
  try {
    const login = '+79157351862';
    const newPassword = 'Benq322solo_ss';
    const hash = await bcrypt.hash(newPassword, 12);

    const result = await pool.query(
      `
      UPDATE users
      SET password = $1
      WHERE login = $2
      RETURNING id, login, full_name, role
      `,
      [hash, login]
    );

    console.log(result.rows);
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();
