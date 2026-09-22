const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query(
  'UPDATE coexistence.akchat_users SET password = $1 WHERE email = $2 RETURNING email',
  ['$2a$10$xwiZIFRROjVSTdZWV.fLMu9Exf73tW56BONBt52lH4eY2WwuTNWPu', 'invi0905@gmail.com']
).then(r => { console.log('Updated rows:', r.rowCount, r.rows); pool.end(); })
 .catch(e => { console.error(e); pool.end(); });
