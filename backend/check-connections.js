const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
pool.query("SELECT count(*) AS total_connections, (SELECT setting FROM pg_settings WHERE name = 'max_connections') AS max_allowed FROM pg_stat_activity")
  .then(r => { console.log(JSON.stringify(r.rows, null, 2)); pool.end(); })
  .catch(e => { console.error('ERROR:', e.message); pool.end(); });
