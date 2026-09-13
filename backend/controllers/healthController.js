import { dbStatus } from '../config/db.js';

export async function health(req, res) {
  const database = await dbStatus();
  res.json({
    success: database === 'connected',
    service: 'IUB Class Management API',
    database,
    time: new Date().toISOString(),
  });
}
