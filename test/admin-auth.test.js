const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

process.env.DB_CLIENT = 'sqlite';
process.env.DB_SQLITE_FILE = path.join(os.tmpdir(), `dart-dashboard-admin-auth-${process.pid}.db`);
process.env.ADMIN_AUTH_ENABLED = 'true';
process.env.ADMIN_PIN_HASH = '';

const { app } = require('../server');

test('Admin-Aktionen bleiben ohne konfigurierte PIN gesperrt', async () => {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/backups`);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Admin-PIN ist nicht konfiguriert/);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
