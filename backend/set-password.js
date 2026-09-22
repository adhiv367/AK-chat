const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const newPassword = process.argv[2];
if (!newPassword) { console.error('Usage: node set-password.js <newpassword>'); process.exit(1); }
bcrypt.hash(newPassword, 10).then(hash =>
  pool.query('UPDATE coexistence.akchat_users SET password = $1 WHERE email = $2 RETURNING email', [hash, 'invi0905@gmail.com'])
).then(r => { console.log('Updated rows:', r.rowCount, r.rows); pool.end(); })
 .catch(e => { console.error(e); pool.end(); });
