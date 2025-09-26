require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const paymobService = require('./services/paymob');
let twilioClient = null;

// Centralised configuration so developers can clearly see which environment
// variables drive runtime behaviour. Defaults keep local development working
// without real credentials.
const rawPort = process.env.PORT || 3000;
const CONFIG = {
  port: Number(rawPort),
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me',
  apiBaseUrl: process.env.API_BASE_URL || `http://localhost:${rawPort}`,
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  mapProvider: process.env.MAP_PROVIDER || 'leaflet',
  osmRoutingUrl: process.env.OSM_ROUTING_URL || 'https://router.project-osrm.org/route/v1',
  nominatimUrl: process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org',
  maptilerKey: process.env.MAPTILER_KEY || '',
  mapboxToken: process.env.MAPBOX_TOKEN || '',
  payProvider: process.env.PAY_PROVIDER || 'paymob',
  paymobApiKey: process.env.PAYMOB_API_KEY || '',
  paymobIntegrationIdCard: process.env.PAYMOB_INTEGRATION_ID_CARD || '',
  paymobIframeId: process.env.PAYMOB_IFRAME_ID || '',
  paymobHmacSecret: process.env.PAYMOB_HMAC_SECRET || '',
  paymobBaseUrl: process.env.PAYMOB_BASE || 'https://accept.paymob.com',
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  searchRadiusKm: Number(process.env.SEARCH_RADIUS_KM || 7),
  baseUrl: process.env.BASE_URL || `http://localhost:${rawPort}`,
  frontendUrl: process.env.FRONTEND_URL || `http://localhost:${rawPort}`,
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER || '',
  environment: process.env.NODE_ENV || 'development'
};

const paymobClient = paymobService.createClient({
  apiKey: CONFIG.paymobApiKey,
  baseUrl: CONFIG.paymobBaseUrl,
  integrationId: CONFIG.paymobIntegrationIdCard,
  iframeId: CONFIG.paymobIframeId
});

if (CONFIG.twilioAccountSid && CONFIG.twilioAuthToken && CONFIG.twilioFromNumber) {
  try {
    const twilio = require('twilio');
    twilioClient = twilio(CONFIG.twilioAccountSid, CONFIG.twilioAuthToken);
  } catch (error) {
    console.warn('Failed to initialise Twilio client, falling back to mock OTP delivery.', error);
    twilioClient = null;
  }
} else {
  console.warn('Twilio credentials missing; OTP codes will be logged and returned in responses for development.');
}

const ORDER_STATUS = {
  CREATED: 'CREATED',
  SEARCHING_DRIVER: 'SEARCHING_DRIVER',
  DRIVER_ASSIGNED: 'DRIVER_ASSIGNED',
  DRIVER_ARRIVED_PICKUP: 'DRIVER_ARRIVED_PICKUP',
  PICKED_UP: 'PICKED_UP',
  IN_TRANSIT: 'IN_TRANSIT',
  ARRIVED_DROPOFF: 'ARRIVED_DROPOFF',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED'
};

const ORDER_TRANSITIONS = {
  [ORDER_STATUS.CREATED]: [ORDER_STATUS.SEARCHING_DRIVER, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.SEARCHING_DRIVER]: [ORDER_STATUS.DRIVER_ASSIGNED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.DRIVER_ASSIGNED]: [ORDER_STATUS.DRIVER_ARRIVED_PICKUP, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.DRIVER_ARRIVED_PICKUP]: [ORDER_STATUS.PICKED_UP, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.PICKED_UP]: [ORDER_STATUS.IN_TRANSIT, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.IN_TRANSIT]: [ORDER_STATUS.ARRIVED_DROPOFF, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.ARRIVED_DROPOFF]: [ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED]
};

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

const app = express();
app.use(helmet());
app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

const quoteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});

const payLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

// Resolve allowed origins for CORS. If the developer did not provide
// `CORS_ORIGINS`, we default to local addresses only to avoid exposing the
// API publicly by accident.
const defaultCorsOrigins = [
  `http://localhost:${CONFIG.port}`,
  `http://127.0.0.1:${CONFIG.port}`,
  CONFIG.frontendUrl,
  CONFIG.apiBaseUrl
].filter(Boolean);
const allowList = CONFIG.corsOrigins.length ? CONFIG.corsOrigins : defaultCorsOrigins;
const uniqueAllowList = [...new Set(allowList)];
const allowOrigin = (origin, callback) => {
  if (!origin) {
    return callback(null, true);
  }
  if (!uniqueAllowList.length || uniqueAllowList.includes(origin)) {
    return callback(null, true);
  }
  return callback(new Error('Not allowed by CORS'));
};

app.use(
  cors({
    origin: allowOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: false
  })
);

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowOrigin,
    methods: ['GET', 'POST'],
    credentials: false
  }
});

const resolvedDbPath = (() => {
  const customPath = process.env.SQLITE_DB_PATH;
  if (!customPath) {
    return path.join(__dirname, 'delivery_app.db');
  }
  if (customPath === ':memory:') {
    return ':memory:';
  }
  return path.isAbsolute(customPath)
    ? customPath
    : path.join(__dirname, customPath);
})();

const db = new sqlite3.Database(resolvedDbPath);

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function runCallback(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ lastID: this.lastID, changes: this.changes });
      }
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row || null);
      }
    });
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows || []);
      }
    });
  });

const closeDatabase = () =>
  new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });

async function ensureColumn(table, column, definition) {
  const info = await dbAll(`PRAGMA table_info(${table})`);
  const exists = info.some((row) => row.name === column);
  if (!exists) {
    await dbRun(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function migrateUsersTable() {
  const tableExists = await dbGet(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  );
  if (!tableExists) {
    await dbRun(`CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password_hash TEXT,
        phone_number TEXT,
        name TEXT,
        role TEXT DEFAULT 'customer',
        oauth_provider TEXT,
        oauth_sub TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`);
  } else {
    const info = await dbAll('PRAGMA table_info(users)');
    const columns = info.map((row) => row.name);
    const phoneColumn = info.find((row) => row.name === 'phone_number');
    const needsMigration =
      !columns.includes('email') ||
      !columns.includes('password_hash') ||
      !columns.includes('oauth_provider') ||
      !columns.includes('oauth_sub') ||
      (phoneColumn && phoneColumn.notnull === 1);

    if (needsMigration) {
      await dbRun('ALTER TABLE users RENAME TO users_old');
      await dbRun(`CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE,
          password_hash TEXT,
          phone_number TEXT,
          name TEXT,
          role TEXT DEFAULT 'customer',
          oauth_provider TEXT,
          oauth_sub TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
      await dbRun(`INSERT INTO users (id, email, password_hash, phone_number, name, role, oauth_provider, oauth_sub, created_at)
                   SELECT id,
                          NULL,
                          NULL,
                          phone_number,
                          name,
                          role,
                          NULL,
                          NULL,
                          created_at
                     FROM users_old`);
      await dbRun('DROP TABLE users_old');
    } else {
      await ensureColumn('users', 'password_hash', 'password_hash TEXT');
      await ensureColumn('users', 'oauth_provider', 'oauth_provider TEXT');
      await ensureColumn('users', 'oauth_sub', 'oauth_sub TEXT');
    }
  }

  await dbRun(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL'
  );
  await dbRun(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone_number) WHERE phone_number IS NOT NULL'
  );
}

async function initDatabase() {
  await migrateUsersTable();

  await dbRun(`CREATE TABLE IF NOT EXISTS drivers (
      user_id INTEGER PRIMARY KEY NOT NULL,
      vehicle_type TEXT NOT NULL,
      license_plate TEXT,
      verified BOOLEAN DEFAULT 0,
      availability_status TEXT DEFAULT 'offline',
      last_lat REAL,
      last_lng REAL,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      driver_id INTEGER,
      pickup_lat REAL NOT NULL,
      pickup_lng REAL NOT NULL,
      dropoff_lat REAL NOT NULL,
      dropoff_lng REAL NOT NULL,
      status TEXT NOT NULL DEFAULT '${ORDER_STATUS.CREATED}',
      price REAL,
      distance_km REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES users (id),
      FOREIGN KEY (driver_id) REFERENCES drivers (user_id)
    )`);

  // Ensure legacy databases pick up any missing columns.
  await ensureColumn('orders', 'driver_id', 'driver_id INTEGER');
  await ensureColumn('orders', 'distance_km', 'distance_km REAL');
  await ensureColumn('orders', 'price', 'price REAL');
  await ensureColumn('orders', 'status', `status TEXT NOT NULL DEFAULT '${ORDER_STATUS.CREATED}'`);
  await ensureColumn('orders', 'price_total', 'price_total REAL');
  await ensureColumn('orders', 'payment_method', "payment_method TEXT DEFAULT 'cash'");
  await ensureColumn('orders', 'payment_status', "payment_status TEXT DEFAULT 'pending'");
  await ensureColumn('orders', 'pickup_label', 'pickup_label TEXT');
  await ensureColumn('orders', 'dropoff_label', 'dropoff_label TEXT');
  await ensureColumn('drivers', 'availability_status', "availability_status TEXT DEFAULT 'offline'");
  await ensureColumn('drivers', 'last_lat', 'last_lat REAL');
  await ensureColumn('drivers', 'last_lng', 'last_lng REAL');

  await dbRun(`CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      currency TEXT DEFAULT 'EGP',
      status TEXT,
      provider_ref TEXT,
      raw TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders (id)
    )`);

  await dbRun('CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id)');

  await dbRun(`CREATE TABLE IF NOT EXISTS otps (
      phone TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);

  await dbRun(`CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL
    )`);
}


const driverSockets = new Map();
const customerSockets = new Map();
let adminToken = null;

function normalisePhone(value) {
  return (value || '').replace(/[^+\d]/g, '').trim();
}

function signUserToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, CONFIG.jwtSecret, { expiresIn: '7d' });
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function verifyPaymobHmac(payload, secret) {
  if (!payload || !payload.obj || !secret) {
    return false;
  }
  const transaction = payload.obj;
  const fields = [
    'amount_cents',
    'created_at',
    'currency',
    'error_occured',
    'has_parent_transaction',
    'id',
    'integration_id',
    'is_3d_secure',
    'is_auth',
    'is_capture',
    'is_refunded',
    'is_standalone_payment',
    'is_voided',
    'order.id',
    'owner',
    'pending',
    'source_data.pan',
    'source_data.sub_type',
    'source_data.type',
    'success'
  ];
  const toString = (value) => (value == null ? '' : String(value));
  const concatenated = fields
    .map((path) => {
      const segments = path.split('.');
      let value = transaction;
      for (const segment of segments) {
        value = value ? value[segment] : undefined;
      }
      return toString(value);
    })
    .join('');
  const computed = crypto
    .createHmac('sha512', secret)
    .update(concatenated)
    .digest('hex');
  return computed === String(payload.hmac || '').toLowerCase();
}

async function getUserById(userId) {
  return dbGet('SELECT * FROM users WHERE id = ?', [userId]);
}

async function getUserByPhone(phoneNumber) {
  return dbGet('SELECT * FROM users WHERE phone_number = ?', [phoneNumber]);
}

async function ensureUserByPhone(phoneNumber, desiredRole = 'customer') {
  const existing = await getUserByPhone(phoneNumber);
  if (existing) {
    if (desiredRole === 'driver' && existing.role !== 'driver') {
      await dbRun('UPDATE users SET role = ? WHERE id = ?', ['driver', existing.id]);
      return getUserById(existing.id);
    }
    return existing;
  }
  const insert = await dbRun(
    'INSERT INTO users (phone_number, role) VALUES (?, ?)',
    [phoneNumber, desiredRole]
  );
  return getUserById(insert.lastID);
}

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const OTP_RATE_LIMIT_MAX = 3;

async function upsertOtp(phoneNumber, code, expiresAt) {
  await dbRun(
    `INSERT INTO otps (phone, code, expires_at)
       VALUES (?, ?, ?)
       ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at`,
    [phoneNumber, code, expiresAt]
  );
}

async function consumeOtp(phoneNumber, code) {
  const record = await dbGet('SELECT code, expires_at FROM otps WHERE phone = ?', [phoneNumber]);
  if (!record) {
    return { valid: false, reason: 'OTP_NOT_FOUND' };
  }
  if (Number(record.expires_at) < Date.now()) {
    await dbRun('DELETE FROM otps WHERE phone = ?', [phoneNumber]);
    return { valid: false, reason: 'OTP_EXPIRED' };
  }
  const matches = String(record.code) === String(code);
  if (matches) {
    await dbRun('DELETE FROM otps WHERE phone = ?', [phoneNumber]);
  }
  return { valid: matches, reason: matches ? 'OK' : 'OTP_MISMATCH' };
}

async function incrementRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const existing = await dbGet('SELECT count, window_start FROM rate_limits WHERE key = ?', [key]);
  if (!existing) {
    await dbRun('INSERT INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)', [key, 1, now]);
    return { allowed: true, remaining: limit - 1 };
  }
  const windowStart = Number(existing.window_start);
  if (now - windowStart > windowMs) {
    await dbRun('UPDATE rate_limits SET count = ?, window_start = ? WHERE key = ?', [1, now, key]);
    return { allowed: true, remaining: limit - 1 };
  }
  const nextCount = Number(existing.count) + 1;
  await dbRun('UPDATE rate_limits SET count = ? WHERE key = ?', [nextCount, key]);
  if (nextCount > limit) {
    return { allowed: false, remaining: 0 };
  }
  return { allowed: true, remaining: limit - nextCount };
}

async function sendOtpSms(phoneNumber, code) {
  if (!twilioClient || !CONFIG.twilioFromNumber) {
    console.info(`[OTP] Mock code for ${phoneNumber}: ${code}`);
    return { delivered: false, mock: true };
  }
  try {
    await twilioClient.messages.create({
      to: phoneNumber,
      from: CONFIG.twilioFromNumber,
      body: `رمز التحقق الخاص بك في Waslny هو ${code}`
    });
    return { delivered: true, mock: false };
  } catch (error) {
    console.error('Failed to send OTP via Twilio', error);
    return { delivered: false, mock: true };
  }
}

async function getDriverById(userId) {
  return dbGet('SELECT * FROM drivers WHERE user_id = ?', [userId]);
}

async function getOrderDetails(orderId) {
  const row = await dbGet(
    `SELECT o.*, 
            cu.name AS customer_name, cu.phone_number AS customer_phone,
            du.name AS driver_name, du.phone_number AS driver_phone,
            d.vehicle_type, d.license_plate
       FROM orders o
       JOIN users cu ON cu.id = o.customer_id
       LEFT JOIN drivers d ON d.user_id = o.driver_id
       LEFT JOIN users du ON du.id = o.driver_id
      WHERE o.id = ?`,
    [orderId]
  );

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    status: row.status,
    price: row.price != null ? Number(row.price) : null,
    priceTotal:
      row.price_total != null
        ? Number(row.price_total)
        : row.price != null
        ? Number(row.price)
        : null,
    distanceKm: row.distance_km != null ? Number(row.distance_km) : null,
    createdAt: row.created_at,
    paymentMethod: row.payment_method || 'cash',
    paymentStatus: row.payment_status || 'pending',
    pickupLabel: row.pickup_label || null,
    dropoffLabel: row.dropoff_label || null,
    pickup: { lat: Number(row.pickup_lat), lng: Number(row.pickup_lng) },
    dropoff: { lat: Number(row.dropoff_lat), lng: Number(row.dropoff_lng) },
    customer: {
      id: row.customer_id,
      name: row.customer_name || '',
      phoneNumber: row.customer_phone
    },
    driver: row.driver_id
      ? {
          id: row.driver_id,
          name: row.driver_name || '',
          phoneNumber: row.driver_phone || '',
          vehicleType: row.vehicle_type || '',
          licensePlate: row.license_plate || ''
        }
      : null
  };
}

async function quoteTrip(pickup, dropoff) {
  const normalisePoint = (point) => {
    const lat = Number(point?.lat);
    const lng = Number(point?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new HttpError(400, 'Invalid coordinates provided');
    }
    return { lat, lng };
  };

  const origin = normalisePoint(pickup);
  const destination = normalisePoint(dropoff);

  const baseUrl = (CONFIG.osmRoutingUrl || '').replace(/\/$/, '') ||
    'https://router.project-osrm.org/route/v1';
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const url = `${baseUrl}/driving/${coords}?overview=false&geometries=geojson`;

  let data;
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'waslny-mvp/1.0'
      }
    });
    if (!response.ok) {
      throw new HttpError(502, 'Routing service unavailable');
    }
    data = await response.json();
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(502, 'Failed to reach routing service');
  }

  const route = data?.routes?.[0];
  if (!route) {
    throw new HttpError(404, 'No route found');
  }

  const distanceKm = route.distance / 1000;
  const durationMin = route.duration / 60;
  const baseFare = 20;
  const perKmRate = 4;
  const price = baseFare + distanceKm * perKmRate;

  return {
    distanceKm: Number(distanceKm.toFixed(2)),
    durationMin: Number(durationMin.toFixed(0)),
    price: Number(price.toFixed(2)),
    priceTotal: Number(price.toFixed(2))
  };
}

function emitToCustomer(customerId, event, payload) {
  const socket = customerSockets.get(customerId);
  if (socket) {
    socket.emit(event, payload);
  }
}

function emitToDriver(driverId, event, payload) {
  const socket = driverSockets.get(driverId);
  if (socket) {
    socket.emit(event, payload);
  }
}

async function emitOrderStatus(orderId) {
  const details = await getOrderDetails(orderId);
  if (!details) {
    return;
  }
  io.to(`order_${orderId}`).emit('order:status', details);
  emitToCustomer(details.customer.id, 'order:status', details);
  if (details.driver) {
    emitToDriver(details.driver.id, 'order:status', details);
  }
}

async function requestDriverStatusUpdate(orderId, driverId) {
  const details = await getOrderDetails(orderId);
  if (!details) {
    return;
  }
  emitToDriver(driverId, 'order:status:update_request', details);
}

async function findNearestDriver(pickup) {
  const drivers = await dbAll(
    `SELECT user_id, last_lat, last_lng
       FROM drivers
      WHERE verified = 1 AND availability_status = 'online'
        AND last_lat IS NOT NULL AND last_lng IS NOT NULL`
  );

  const candidates = drivers
    .map((driver) => ({
      ...driver,
      distanceKm: haversineDistance(pickup.lat, pickup.lng, driver.last_lat, driver.last_lng)
    }))
    .filter((driver) => driver.distanceKm <= CONFIG.searchRadiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return candidates[0] || null;
}

async function assignDriverToOrder(orderId) {
  const order = await dbGet('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order || order.status !== ORDER_STATUS.SEARCHING_DRIVER) {
    return false;
  }

  const nearestDriver = await findNearestDriver({ lat: order.pickup_lat, lng: order.pickup_lng });
  if (!nearestDriver) {
    await dbRun('UPDATE orders SET status = ? WHERE id = ?', [
      ORDER_STATUS.CANCELLED,
      orderId
    ]);
    if ((order.payment_method || 'cash').toLowerCase() === 'card') {
      await dbRun('UPDATE orders SET payment_status = ? WHERE id = ?', ['failed', orderId]);
    }
    const details = await getOrderDetails(orderId);
    const payload = details
      ? { ...details, reason: 'NO_DRIVER' }
      : { id: orderId, status: order.status, reason: 'NO_DRIVER' };
    emitToCustomer(order.customer_id, 'order:status', payload);
    io.to(`order_${orderId}`).emit('order:status', payload);
    return false;
  }

  const update = await dbRun(
    'UPDATE orders SET driver_id = ?, status = ? WHERE id = ? AND status = ?',
    [nearestDriver.user_id, ORDER_STATUS.DRIVER_ASSIGNED, orderId, ORDER_STATUS.SEARCHING_DRIVER]
  );
  if (!update.changes) {
    return false;
  }

  await dbRun('UPDATE drivers SET availability_status = ? WHERE user_id = ?', [
    'busy',
    nearestDriver.user_id
  ]);

  const details = await getOrderDetails(orderId);
  if (details) {
    emitToCustomer(details.customer.id, 'order:driver_assigned', details);
    emitToDriver(nearestDriver.user_id, 'order:offer', details);
    io.to(`order_${orderId}`).emit('order:driver_assigned', details);
    await requestDriverStatusUpdate(orderId, nearestDriver.user_id);
  }

  return true;
}

async function assignPendingOrders() {
  const pending = await dbAll(
    'SELECT id FROM orders WHERE status = ? ORDER BY created_at ASC',
    [ORDER_STATUS.SEARCHING_DRIVER]
  );
  for (const row of pending) {
    await assignDriverToOrder(row.id);
  }
}

// --- Configuration endpoint shared by the three front-ends ---
app.use('/api/quote', quoteLimiter);

app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`// generated by server\nwindow.__APP_CONFIG__ = ${JSON.stringify({
    API_BASE_URL: CONFIG.apiBaseUrl,
    GOOGLE_MAPS_API_KEY: CONFIG.googleMapsApiKey,
    MAP_PROVIDER: CONFIG.mapProvider,
    OSM_ROUTING_URL: CONFIG.osmRoutingUrl,
    NOMINATIM_URL: CONFIG.nominatimUrl,
    MAPTILER_KEY: CONFIG.maptilerKey,
    MAPBOX_TOKEN: CONFIG.mapboxToken,
    NODE_ENV: CONFIG.environment,
    PAY_PROVIDER: CONFIG.payProvider
  })};`);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Authentication Endpoints (OTP only) ---
const otpRequestHandlers = ['/api/auth/otp/request', '/v1/auth/otp/request'];
otpRequestHandlers.forEach((route) => {
  app.post(route, authLimiter, async (req, res, next) => {
    try {
      const { phone } = req.body || {};
      const normalised = normalisePhone(phone);
      if (!normalised || normalised.length < 6) {
        throw new HttpError(400, 'رقم الجوال غير صالح');
      }

      const rateKey = `otp:${normalised}`;
      const { allowed } = await incrementRateLimit(
        rateKey,
        OTP_RATE_LIMIT_MAX,
        OTP_RATE_LIMIT_WINDOW_MS
      );
      if (!allowed) {
        throw new HttpError(429, 'تم تجاوز الحد المسموح لطلبات رمز التحقق. حاول لاحقًا.');
      }

      const code = String(Math.floor(1000 + Math.random() * 9000));
      const expiresAt = Date.now() + OTP_TTL_MS;
      await upsertOtp(normalised, code, expiresAt);
      const delivery = await sendOtpSms(normalised, code);

      res.json({
        success: true,
        mock: delivery.mock,
        expiresIn: Math.floor(OTP_TTL_MS / 1000),
        code: delivery.mock ? code : undefined
      });
    } catch (error) {
      next(error);
    }
  });
});

const otpVerifyHandlers = ['/api/auth/otp/verify', '/v1/auth/otp/verify'];
otpVerifyHandlers.forEach((route) => {
  app.post(route, authLimiter, async (req, res, next) => {
    try {
      const { phone, code, role } = req.body || {};
      const normalised = normalisePhone(phone);
      if (!normalised || normalised.length < 6) {
        throw new HttpError(400, 'رقم الجوال غير صالح');
      }
      if (!code || String(code).trim().length < 4) {
        throw new HttpError(400, 'رمز التحقق مطلوب');
      }

      const validation = await consumeOtp(normalised, String(code).trim());
      if (!validation.valid) {
        throw new HttpError(400, 'رمز التحقق غير صحيح أو منتهي الصلاحية');
      }

      const desiredRole = String(role || 'customer').toLowerCase() === 'driver' ? 'driver' : 'customer';
      const user = await ensureUserByPhone(normalised, desiredRole);
      await dbRun('UPDATE users SET phone_number = ? WHERE id = ?', [normalised, user.id]);
      const token = signUserToken(user);
      const driver = await getDriverById(user.id);

      res.json({
        success: true,
        token,
        role: user.role,
        isDriverVerified: driver ? Boolean(driver.verified) : null
      });
    } catch (error) {
      next(error);
    }
  });
});

// --- Auth middleware ---
async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
      throw new HttpError(401, 'Unauthorized');
    }
    let payload;
    try {
      payload = jwt.verify(token, CONFIG.jwtSecret);
    } catch (error) {
      throw new HttpError(401, 'Unauthorized');
    }
    const user = await getUserById(payload.sub);
    if (!user) {
      throw new HttpError(401, 'Unauthorized');
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

// --- Driver Management ---
app.post('/api/drivers/register', authenticate, async (req, res, next) => {
  try {
    const { name, vehicleType, licensePlate, phoneNumber } = req.body || {};
    if (!name || !vehicleType || !licensePlate || !phoneNumber) {
      throw new HttpError(400, 'Name, phone number, vehicle type, and license plate are required');
    }

    const existingDriver = await getDriverById(req.user.id);
    if (existingDriver) {
      throw new HttpError(409, 'Driver already registered');
    }

    await dbRun('UPDATE users SET name = ?, role = ?, phone_number = ? WHERE id = ?', [
      name,
      'driver',
      phoneNumber,
      req.user.id
    ]);
    await dbRun(
      'INSERT INTO drivers (user_id, vehicle_type, license_plate, verified, availability_status) VALUES (?, ?, ?, 0, ?)',
      [req.user.id, vehicleType, licensePlate, 'offline']
    );

    res.status(201).json({ success: true, message: 'Registration submitted.' });
  } catch (error) {
    next(error);
  }
});

app.get('/api/drivers/me', authenticate, async (req, res, next) => {
  try {
    const driver = await getDriverById(req.user.id);
    res.json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        phoneNumber: req.user.phone_number,
        name: req.user.name,
        role: req.user.role
      },
      driver: driver
        ? {
            userId: driver.user_id,
            vehicleType: driver.vehicle_type,
            licensePlate: driver.license_plate,
            verified: Boolean(driver.verified),
            availabilityStatus: driver.availability_status
          }
        : null
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/drivers/status', authenticate, async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!status || !['online', 'offline'].includes(status)) {
      throw new HttpError(400, 'Status must be "online" or "offline"');
    }

    const driver = await getDriverById(req.user.id);
    if (!driver) {
      throw new HttpError(404, 'Driver profile not found');
    }
    if (!driver.verified) {
      throw new HttpError(403, 'Driver not verified');
    }

    if (status === 'offline') {
      const activeOrder = await dbGet(
        'SELECT id FROM orders WHERE driver_id = ? AND status NOT IN (?, ?, ?)',
        [req.user.id, ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED, ORDER_STATUS.CREATED]
      );
      if (activeOrder) {
        throw new HttpError(400, 'Cannot go offline while delivering an order');
      }
    }

    await dbRun('UPDATE drivers SET availability_status = ? WHERE user_id = ?', [
      status,
      req.user.id
    ]);

    if (status === 'online') {
      await assignPendingOrders();
    }

    res.json({ success: true, status });
  } catch (error) {
    next(error);
  }
});

app.get('/api/drivers/active-order', authenticate, async (req, res, next) => {
  try {
    const row = await dbGet(
      `SELECT id FROM orders WHERE driver_id = ? AND status NOT IN (?, ?, ?) ORDER BY created_at DESC LIMIT 1`,
      [
        req.user.id,
        ORDER_STATUS.DELIVERED,
        ORDER_STATUS.CANCELLED,
        ORDER_STATUS.CREATED
      ]
    );
    if (!row) {
      return res.json(null);
    }
    const details = await getOrderDetails(row.id);
    res.json(details);
  } catch (error) {
    next(error);
  }
});

// --- Orders & Quotes ---
app.post('/api/quote', authenticate, async (req, res, next) => {
  try {
    const { pickup, dropoff } = req.body || {};
    if (!pickup || !dropoff) {
      throw new HttpError(400, 'Pickup and dropoff locations are required');
    }

    const quote = await quoteTrip(pickup, dropoff);
    res.json(quote);
  } catch (error) {
    if (error instanceof HttpError) {
      next(error);
      return;
    }
    console.error('Quote service failed', error);
    next(new HttpError(503, 'خدمة التوجيه غير متاحة مؤقتًا'));
  }
});

app.post('/api/orders', authenticate, async (req, res, next) => {
  try {
    const { pickup, dropoff, paymentMethod: paymentMethodRaw } = req.body || {};
    if (!pickup || !dropoff) {
      throw new HttpError(400, 'Pickup and dropoff locations are required');
    }

    const quote = await quoteTrip(pickup, dropoff);

    const paymentMethod = (paymentMethodRaw || 'cash').toLowerCase();
    if (!['cash', 'card'].includes(paymentMethod)) {
      throw new HttpError(400, 'Unsupported payment method');
    }

    const pickupLabel = pickup.label || req.body?.pickupLabel || null;
    const dropoffLabel = dropoff.label || req.body?.dropoffLabel || null;
    const paymentStatus = paymentMethod === 'card' ? 'pending' : 'pending';
    const priceTotal = quote.price;

    const insert = await dbRun(
      `INSERT INTO orders (
          customer_id,
          pickup_lat,
          pickup_lng,
          dropoff_lat,
          dropoff_lng,
          price,
          price_total,
          distance_km,
          status,
          payment_method,
          payment_status,
          pickup_label,
          dropoff_label
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        pickup.lat,
        pickup.lng,
        dropoff.lat,
        dropoff.lng,
        quote.price,
        priceTotal,
        quote.distanceKm,
        ORDER_STATUS.CREATED,
        paymentMethod,
        paymentStatus,
        pickupLabel,
        dropoffLabel
      ]
    );

    const orderId = insert.lastID;
    await dbRun('UPDATE orders SET status = ? WHERE id = ?', [
      ORDER_STATUS.SEARCHING_DRIVER,
      orderId
    ]);

    const createdDetails = await getOrderDetails(orderId);
    emitToCustomer(req.user.id, 'order:created', createdDetails);
    io.to(`order_${orderId}`).emit('order:created', createdDetails);

    const assigned = await assignDriverToOrder(orderId);
    const details = await getOrderDetails(orderId);

    if (!assigned) {
      res.status(202).json({ ...details, reason: 'NO_DRIVER' });
    } else {
      res.status(201).json(details);
    }
  } catch (error) {
    next(error);
  }
});

app.post('/api/orders/:id/cancel', authenticate, async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    const order = await dbGet('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (!order) {
      throw new HttpError(404, 'Order not found');
    }
    if (order.customer_id !== req.user.id) {
      throw new HttpError(403, 'Forbidden');
    }
    if (order.status === ORDER_STATUS.DELIVERED || order.status === ORDER_STATUS.CANCELLED) {
      throw new HttpError(400, 'Order can no longer be cancelled');
    }

    await dbRun('UPDATE orders SET status = ? WHERE id = ?', [ORDER_STATUS.CANCELLED, orderId]);
    if (order.driver_id) {
      await dbRun('UPDATE drivers SET availability_status = ? WHERE user_id = ?', [
        'online',
        order.driver_id
      ]);
      emitToDriver(order.driver_id, 'order:cancelled', await getOrderDetails(orderId));
    }

    await emitOrderStatus(orderId);
    res.json({ success: true });
    await assignPendingOrders();
  } catch (error) {
    next(error);
  }
});

app.get('/api/orders/history', authenticate, async (req, res, next) => {
  try {
    const rows = await dbAll(
      'SELECT id FROM orders WHERE customer_id = ? ORDER BY created_at DESC',
      [req.user.id]
    );
    const history = [];
    for (const row of rows) {
      const details = await getOrderDetails(row.id);
      if (details) {
        history.push(details);
      }
    }
    res.json(history);
  } catch (error) {
    next(error);
  }
});

app.get('/v1/orders/my', authenticate, async (req, res, next) => {
  try {
    const role = (req.query.role || req.user.role || 'customer').toLowerCase();
    let rows;
    if (role === 'driver') {
      rows = await dbAll(
        `SELECT id, status, price_total, price, payment_method, payment_status, created_at, pickup_label, dropoff_label
           FROM orders
          WHERE driver_id = ?
          ORDER BY created_at DESC
          LIMIT 50`,
        [req.user.id]
      );
    } else {
      rows = await dbAll(
        `SELECT id, status, price_total, price, payment_method, payment_status, created_at, pickup_label, dropoff_label
           FROM orders
          WHERE customer_id = ?
          ORDER BY created_at DESC
          LIMIT 50`,
        [req.user.id]
      );
    }
    const history = rows.map((row) => ({
      id: row.id,
      status: row.status,
      priceTotal:
        row.price_total != null
          ? Number(row.price_total)
          : row.price != null
          ? Number(row.price)
          : null,
      paymentMethod: row.payment_method || 'cash',
      paymentStatus: row.payment_status || 'pending',
      createdAt: row.created_at,
      pickupLabel: row.pickup_label || null,
      dropoffLabel: row.dropoff_label || null
    }));
    res.json(history);
  } catch (error) {
    next(error);
  }
});

app.get('/v1/orders/:id', authenticate, async (req, res, next) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isFinite(orderId)) {
      throw new HttpError(400, 'Invalid order id');
    }
    const details = await getOrderDetails(orderId);
    if (!details) {
      throw new HttpError(404, 'Order not found');
    }
    const isCustomer = details.customer.id === req.user.id;
    const isDriver = details.driver?.id === req.user.id;
    if (!isCustomer && !isDriver) {
      throw new HttpError(403, 'Forbidden');
    }
    res.json(details);
  } catch (error) {
    next(error);
  }
});

app.post('/v1/pay/paymob/init', authenticate, payLimiter, async (req, res, next) => {
  try {
    if (CONFIG.payProvider !== 'paymob') {
      throw new HttpError(503, 'Card payments are not enabled');
    }
    if (!CONFIG.paymobApiKey || !CONFIG.paymobIntegrationIdCard || !CONFIG.paymobIframeId) {
      throw new HttpError(503, 'Paymob credentials are not fully configured');
    }
    const { orderId } = req.body || {};
    const numericOrderId = Number(orderId);
    if (!Number.isFinite(numericOrderId)) {
      throw new HttpError(400, 'A valid orderId is required');
    }
    const order = await dbGet('SELECT * FROM orders WHERE id = ?', [numericOrderId]);
    if (!order) {
      throw new HttpError(404, 'Order not found');
    }
    if (order.customer_id !== req.user.id) {
      throw new HttpError(403, 'You can only pay for your own orders');
    }
    const method = (order.payment_method || 'cash').toLowerCase();
    if (method !== 'card') {
      throw new HttpError(400, 'This order is not configured for card payment');
    }
    if (order.payment_status === 'paid') {
      return res.json({ iframe_url: null, status: 'paid' });
    }
    const priceSource =
      order.price_total != null
        ? Number(order.price_total)
        : order.price != null
        ? Number(order.price)
        : null;
    if (!Number.isFinite(priceSource) || priceSource <= 0) {
      throw new HttpError(400, 'Order amount is not valid for payment');
    }
    const amountCents = Math.max(1, Math.round(priceSource * 100));
    const authToken = await paymobClient.getAuthToken();
    const merchantOrderId = `order-${numericOrderId}-${Date.now()}`;
    const paymobOrder = await paymobClient.createOrder(authToken, amountCents, merchantOrderId);
    const billingName = (req.user.name || 'Waslny Customer').split(' ');
    const billingData = {
      apartment: 'NA',
      email: req.user.email || `${req.user.id}@waslny.local`,
      floor: 'NA',
      first_name: billingName[0] || 'Waslny',
      street: order.pickup_label || 'Pickup',
      building: 'NA',
      phone_number: req.user.phone_number || '0000000000',
      shipping_method: 'Courier',
      postal_code: '00000',
      city: 'Cairo',
      country: 'EGY',
      last_name: billingName.slice(1).join(' ') || 'Customer',
      state: 'Cairo'
    };
    const paymentToken = await paymobClient.getPaymentKey(authToken, {
      orderId: paymobOrder.id,
      amountCents,
      billingData,
      integrationId: CONFIG.paymobIntegrationIdCard
    });
    const iframeUrl = paymobClient.buildIframeUrl(paymentToken);

    await dbRun(
      'INSERT INTO payments (order_id, provider, amount_cents, currency, status, provider_ref, raw) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        numericOrderId,
        'paymob',
        amountCents,
        'EGP',
        'pending',
        String(paymobOrder.id),
        JSON.stringify({ order: paymobOrder })
      ]
    );

    await dbRun('UPDATE orders SET payment_status = ?, payment_method = ? WHERE id = ?', [
      'pending',
      'card',
      numericOrderId
    ]);

    res.json({ iframe_url: iframeUrl, payment_token: paymentToken });
  } catch (error) {
    next(error);
  }
});

app.post('/v1/pay/paymob/webhook', async (req, res, next) => {
  try {
    if (CONFIG.payProvider !== 'paymob') {
      return res.json({ ok: true });
    }
    if (!verifyPaymobHmac(req.body, CONFIG.paymobHmacSecret)) {
      throw new HttpError(401, 'Invalid signature');
    }
    const transaction = req.body.obj;
    const paymobOrderId = transaction?.order?.id ? String(transaction.order.id) : null;
    let orderId = null;
    const merchantOrderId = transaction?.order?.merchant_order_id;
    if (merchantOrderId) {
      const match = String(merchantOrderId).match(/order-(\d+)/);
      if (match) {
        orderId = Number(match[1]);
      }
    }
    if (!orderId && paymobOrderId) {
      const paymentRow = await dbGet(
        'SELECT order_id FROM payments WHERE provider = ? AND provider_ref = ? ORDER BY id DESC LIMIT 1',
        ['paymob', paymobOrderId]
      );
      if (paymentRow) {
        orderId = Number(paymentRow.order_id);
      }
    }
    if (!orderId) {
      throw new HttpError(404, 'Order reference not found');
    }
    const success = transaction?.success === true && transaction?.pending === false;
    const status = success ? 'paid' : 'failed';
    const rawJson = JSON.stringify(transaction);
    if (paymobOrderId) {
      const update = await dbRun(
        'UPDATE payments SET status = ?, raw = ? WHERE provider = ? AND provider_ref = ?',
        [status, rawJson, 'paymob', paymobOrderId]
      );
      if (!update.changes) {
        await dbRun(
          'INSERT INTO payments (order_id, provider, amount_cents, currency, status, provider_ref, raw) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [orderId, 'paymob', Number(transaction.amount_cents || 0), transaction.currency || 'EGP', status, paymobOrderId, rawJson]
        );
      }
    }
    await dbRun('UPDATE orders SET payment_status = ?, payment_method = ? WHERE id = ?', [
      status,
      'card',
      orderId
    ]);
    await emitOrderStatus(orderId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/orders/active', authenticate, async (req, res, next) => {
  try {
    const row = await dbGet(
      `SELECT id FROM orders WHERE customer_id = ? AND status NOT IN (?, ?, ?) ORDER BY created_at DESC LIMIT 1`,
      [
        req.user.id,
        ORDER_STATUS.DELIVERED,
        ORDER_STATUS.CANCELLED,
        ORDER_STATUS.CREATED
      ]
    );
    if (!row) {
      return res.json(null);
    }
    const details = await getOrderDetails(row.id);
    res.json(details);
  } catch (error) {
    next(error);
  }
});

// --- Admin Endpoints ---
app.post('/api/admin/login', async (req, res, next) => {
  try {
    const { password } = req.body || {};
    if (password !== CONFIG.adminPassword) {
      throw new HttpError(401, 'Invalid password');
    }
    adminToken = crypto.randomBytes(32).toString('hex');
    res.json({ success: true, token: adminToken });
  } catch (error) {
    next(error);
  }
});

function authenticateAdmin(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (token && token === adminToken) {
    return next();
  }
  next(new HttpError(401, 'Unauthorized admin'));
}

app.get('/api/admin/drivers', authenticateAdmin, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT u.id, u.name, u.phone_number, d.vehicle_type, d.license_plate, d.verified, d.availability_status, d.last_lat, d.last_lng
         FROM drivers d
         JOIN users u ON u.id = d.user_id`
    );
    const list = rows.map((row) => ({
      id: row.id,
      name: row.name,
      phoneNumber: row.phone_number,
      vehicleType: row.vehicle_type,
      licensePlate: row.license_plate,
      verified: Boolean(row.verified),
      availabilityStatus: row.availability_status,
      lastLocation: row.last_lat != null && row.last_lng != null ? { lat: Number(row.last_lat), lng: Number(row.last_lng) } : null
    }));
    res.json(list);
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/drivers/:id/verify', authenticateAdmin, async (req, res, next) => {
  try {
    const driverId = Number(req.params.id);
    const { verified } = req.body || {};
    const update = await dbRun('UPDATE drivers SET verified = ? WHERE user_id = ?', [
      verified ? 1 : 0,
      driverId
    ]);
    if (!update.changes) {
      throw new HttpError(404, 'Driver not found');
    }
    if (!verified) {
      await dbRun('UPDATE drivers SET availability_status = ? WHERE user_id = ?', [
        'offline',
        driverId
      ]);
    } else {
      await assignPendingOrders();
    }
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/payments', authenticateAdmin, async (req, res, next) => {
  try {
    const rows = await dbAll(
      `SELECT id, order_id, provider, amount_cents, currency, status, provider_ref, created_at
         FROM payments
        ORDER BY created_at DESC
        LIMIT 100`
    );
    const list = rows.map((row) => {
      const amountCents = Number(row.amount_cents || 0);
      return {
        id: row.id,
        orderId: row.order_id,
        provider: row.provider,
        amount: amountCents / 100,
        amountCents,
        currency: row.currency || 'EGP',
        status: row.status || 'pending',
        providerRef: row.provider_ref || null,
        createdAt: row.created_at
      };
    });
    res.json(list);
  } catch (error) {
    next(error);
  }
});

// --- Socket.IO Authentication ---
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) {
      throw new Error('Unauthorized');
    }
    let payload;
    try {
      payload = jwt.verify(token, CONFIG.jwtSecret);
    } catch (error) {
      throw new Error('Unauthorized');
    }
    const user = await getUserById(payload.sub);
    if (!user) {
      throw new Error('Unauthorized');
    }
    socket.data.userId = user.id;
    socket.data.role = user.role;
    next();
  } catch (error) {
    next(error);
  }
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  const role = socket.data.role;

  if (role === 'driver') {
    driverSockets.set(userId, socket);
  } else {
    customerSockets.set(userId, socket);
  }

  socket.on('order:join', async ({ orderId }) => {
    if (!orderId) {
      return;
    }
    const order = await dbGet('SELECT customer_id, driver_id FROM orders WHERE id = ?', [orderId]);
    if (!order) {
      return;
    }
    if (order.customer_id === userId || order.driver_id === userId) {
      socket.join(`order_${orderId}`);
      const details = await getOrderDetails(orderId);
      if (details) {
        socket.emit('order:status', details);
      }
    }
  });

  if (role === 'driver') {
    socket.on('driver:send_location', async ({ lat, lng }) => {
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        return;
      }
      await dbRun('UPDATE drivers SET last_lat = ?, last_lng = ? WHERE user_id = ?', [
        lat,
        lng,
        userId
      ]);
      const rows = await dbAll(
        'SELECT id FROM orders WHERE driver_id = ? AND status NOT IN (?, ?, ?)',
        [
          userId,
          ORDER_STATUS.DELIVERED,
          ORDER_STATUS.CANCELLED,
          ORDER_STATUS.CREATED
        ]
      );
      for (const row of rows) {
        const orderDetails = await getOrderDetails(row.id);
        if (!orderDetails) {
          continue;
        }
        const payload = {
          orderId: row.id,
          driverId: userId,
          lat,
          lng,
          updatedAt: new Date().toISOString()
        };
        io.to(`order_${row.id}`).emit('driver:location', payload);
        emitToCustomer(orderDetails.customer.id, 'driver:location', payload);
      }
    });

    socket.on('driver:update_status', async ({ orderId, status }) => {
      if (!orderId || !status) {
        return;
      }
      const order = await dbGet('SELECT * FROM orders WHERE id = ?', [orderId]);
      if (!order || order.driver_id !== userId) {
        return;
      }
      const allowed = ORDER_TRANSITIONS[order.status] || [];
      if (!allowed.includes(status)) {
        return;
      }
      await dbRun('UPDATE orders SET status = ? WHERE id = ?', [status, orderId]);
      if (status === ORDER_STATUS.DELIVERED) {
        await dbRun('UPDATE drivers SET availability_status = ? WHERE user_id = ?', [
          'online',
          userId
        ]);
        await assignPendingOrders();
      }
      await emitOrderStatus(orderId);
      await requestDriverStatusUpdate(orderId, userId);
    });
  }

  socket.on('disconnect', async () => {
    if (role === 'driver') {
      driverSockets.delete(userId);
      const active = await dbGet(
        'SELECT id FROM orders WHERE driver_id = ? AND status NOT IN (?, ?, ?)',
        [
          userId,
          ORDER_STATUS.DELIVERED,
          ORDER_STATUS.CANCELLED,
          ORDER_STATUS.CREATED
        ]
      );
      if (!active) {
        await dbRun('UPDATE drivers SET availability_status = ? WHERE user_id = ?', [
          'offline',
          userId
        ]);
      }
    } else {
      customerSockets.delete(userId);
    }
  });
});

// --- Error handling ---
// Ensure JSON errors are consistent across the API; stack traces stay in dev only.
app.use((err, req, res, next) => {
  const status = err instanceof HttpError ? err.status : err.status || 500;
  const payload = {
    status,
    message: err.message || 'Internal Server Error'
  };
  if (err instanceof HttpError && err.extra) {
    Object.assign(payload, err.extra);
  }
  if (process.env.NODE_ENV !== 'production' && err.stack) {
    payload.stack = err.stack;
  }
  res.status(status).json(payload);
});

async function bootstrap() {
  try {
    await initDatabase();
    server.listen(CONFIG.port, () => {
      console.log(`Server listening on port ${CONFIG.port}`);
      console.log(
        `Allowed CORS origins: ${uniqueAllowList.length ? uniqueAllowList.join(', ') : 'none'}`
      );
    });
  } catch (error) {
    console.error('Failed to start server', error);
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}

module.exports = {
  app,
  server,
  initDatabase,
  closeDatabase,
  CONFIG,
  bootstrap
};
