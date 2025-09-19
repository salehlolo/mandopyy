require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('@googlemaps/google-maps-services-js');

// Centralised configuration so developers can clearly see which environment
// variables drive runtime behaviour. Defaults keep local development working
// without real credentials.
const CONFIG = {
  port: Number(process.env.PORT || 3000),
  adminPassword: process.env.ADMIN_PASSWORD || 'change-me',
  apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER || '',
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  searchRadiusKm: Number(process.env.SEARCH_RADIUS_KM || 7),
  otpExpiryMinutes: Number(process.env.OTP_EXPIRY_MINUTES || 5),
  otpMaxAttempts: Number(process.env.OTP_MAX_ATTEMPTS || 3),
  otpRateWindowMinutes: Number(process.env.OTP_RATE_WINDOW_MINUTES || 15)
};

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

const allowList = CONFIG.corsOrigins;
const allowOrigin = (origin, callback) => {
  if (!origin) {
    return callback(null, true);
  }
  if (!allowList.length || allowList.includes(origin)) {
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

const db = new sqlite3.Database(path.join(__dirname, 'delivery_app.db'));

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

async function ensureColumn(table, column, definition) {
  const info = await dbAll(`PRAGMA table_info(${table})`);
  const exists = info.some((row) => row.name === column);
  if (!exists) {
    await dbRun(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

async function initDatabase() {
  await dbRun(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_number TEXT UNIQUE NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'customer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

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

  // Ensure legacy databases pick up any missing columns.
  await ensureColumn('orders', 'driver_id', 'driver_id INTEGER');
  await ensureColumn('orders', 'distance_km', 'distance_km REAL');
  await ensureColumn('orders', 'price', 'price REAL');
  await ensureColumn('orders', 'status', `status TEXT NOT NULL DEFAULT '${ORDER_STATUS.CREATED}'`);
  await ensureColumn('drivers', 'availability_status', "availability_status TEXT DEFAULT 'offline'");
  await ensureColumn('drivers', 'last_lat', 'last_lat REAL');
  await ensureColumn('drivers', 'last_lng', 'last_lng REAL');
}

const googleMapsClient = new Client({});
// Twilio credentials must be provided through environment variables defined in
// .env. When any of them is missing we automatically run in mock mode so local
// development can continue without sending real SMS messages.
const shouldMockTwilio =
  !CONFIG.twilioAccountSid || !CONFIG.twilioAuthToken || !CONFIG.twilioFromNumber;
const twilioClient = shouldMockTwilio
  ? null
  : require('twilio')(CONFIG.twilioAccountSid, CONFIG.twilioAuthToken);

const sessionStore = new Map();
const driverSockets = new Map();
const customerSockets = new Map();
let adminToken = null;

function createSessionToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  sessionStore.set(token, userId);
  return token;
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

async function getUserById(userId) {
  return dbGet('SELECT * FROM users WHERE id = ?', [userId]);
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
    distanceKm: row.distance_km != null ? Number(row.distance_km) : null,
    createdAt: row.created_at,
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
  if (!CONFIG.googleMapsApiKey) {
    throw new HttpError(500, 'Google Maps API key is not configured');
  }
  const response = await googleMapsClient.directions({
    params: {
      origin: pickup,
      destination: dropoff,
      key: CONFIG.googleMapsApiKey,
      mode: 'DRIVING'
    },
    timeout: 5000
  });

  if (!response.data.routes.length) {
    throw new HttpError(404, 'No route found');
  }

  const leg = response.data.routes[0].legs[0];
  const distanceKm = leg.distance.value / 1000;
  const durationMin = leg.duration.value / 60;
  const baseFare = 20;
  const perKmRate = 4;
  const price = baseFare + distanceKm * perKmRate;

  return {
    distanceKm: Number(distanceKm.toFixed(2)),
    durationMin: Number(durationMin.toFixed(0)),
    price: Number(price.toFixed(2))
  };
}

async function enforceOtpRateLimit(phoneNumber) {
  const key = `otp:${phoneNumber}`;
  const windowMs = CONFIG.otpRateWindowMinutes * 60 * 1000;
  const now = Date.now();
  const record = await dbGet('SELECT * FROM rate_limits WHERE key = ?', [key]);
  if (!record || now - record.window_start > windowMs) {
    await dbRun('REPLACE INTO rate_limits (key, count, window_start) VALUES (?, ?, ?)', [
      key,
      1,
      now
    ]);
    return;
  }
  if (record.count >= CONFIG.otpMaxAttempts) {
    throw new HttpError(429, 'Too many OTP requests', { reason: 'RATE_LIMIT' });
  }
  await dbRun('UPDATE rate_limits SET count = ?, window_start = ? WHERE key = ?', [
    record.count + 1,
    record.window_start,
    key
  ]);
}

async function storeOtp(phoneNumber, code) {
  const expiresAt = Date.now() + CONFIG.otpExpiryMinutes * 60 * 1000;
  await dbRun('REPLACE INTO otps (phone, code, expires_at) VALUES (?, ?, ?)', [
    phoneNumber,
    code,
    expiresAt
  ]);
}

async function consumeOtp(phoneNumber, otpCode) {
  const record = await dbGet('SELECT * FROM otps WHERE phone = ?', [phoneNumber]);
  if (!record) {
    throw new HttpError(400, 'OTP not found or expired');
  }
  if (Date.now() > record.expires_at) {
    await dbRun('DELETE FROM otps WHERE phone = ?', [phoneNumber]);
    throw new HttpError(400, 'OTP not found or expired');
  }
  if (record.code !== otpCode) {
    throw new HttpError(400, 'Invalid OTP code');
  }
  await dbRun('DELETE FROM otps WHERE phone = ?', [phoneNumber]);
  await dbRun('DELETE FROM rate_limits WHERE key = ?', [`otp:${phoneNumber}`]);
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
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(`// generated by server\nwindow.__APP_CONFIG__ = ${JSON.stringify({
    API_BASE_URL: CONFIG.apiBaseUrl,
    GOOGLE_MAPS_API_KEY: CONFIG.googleMapsApiKey
  })};`);
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// --- Authentication Endpoints ---
const requestOtpHandler = async (req, res, next) => {
  try {
    const body = req.body || {};
    const phoneNumber = body.phoneNumber || body.phone;
    if (!phoneNumber) {
      throw new HttpError(400, 'Phone number is required');
    }

    await enforceOtpRateLimit(phoneNumber);
    const otpCode = Math.floor(1000 + Math.random() * 9000).toString();
    await storeOtp(phoneNumber, otpCode);

    if (shouldMockTwilio) {
      console.log(`Mock OTP for ${phoneNumber}: ${otpCode}`);
      return res.json({ success: true, mock: true });
    }

    await twilioClient.messages.create({
      body: `رمز التحقق الخاص بك في تطبيق وصلني هو: ${otpCode}`,
      from: CONFIG.twilioFromNumber,
      to: phoneNumber
    });

    res.json({ success: true, mock: false });
  } catch (error) {
    next(error);
  }
};

app.post('/api/auth/request-otp', requestOtpHandler);
app.post('/api/auth/otp/request', requestOtpHandler);

const verifyOtpHandler = async (req, res, next) => {
  try {
    const body = req.body || {};
    const phoneNumber = body.phoneNumber || body.phone;
    const otpCode = body.otpCode || body.code;
    if (!phoneNumber || !otpCode) {
      throw new HttpError(400, 'Phone number and OTP are required');
    }

    await consumeOtp(phoneNumber, otpCode);
    let user = await dbGet('SELECT * FROM users WHERE phone_number = ?', [phoneNumber]);
    if (!user) {
      const insert = await dbRun('INSERT INTO users (phone_number) VALUES (?)', [phoneNumber]);
      user = await getUserById(insert.lastID);
    }

    const driver = await getDriverById(user.id);
    const token = createSessionToken(user.id);
    res.json({
      success: true,
      token,
      role: user.role,
      isDriverVerified: driver ? Boolean(driver.verified) : null
    });
  } catch (error) {
    next(error);
  }
};

app.post('/api/auth/verify-otp', verifyOtpHandler);
app.post('/api/auth/otp/verify', verifyOtpHandler);

// --- Auth middleware ---
async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !sessionStore.has(token)) {
      throw new HttpError(401, 'Unauthorized');
    }
    const userId = sessionStore.get(token);
    const user = await getUserById(userId);
    if (!user) {
      sessionStore.delete(token);
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
    const { name, vehicleType, licensePlate } = req.body || {};
    if (!name || !vehicleType || !licensePlate) {
      throw new HttpError(400, 'Name, vehicle type, and license plate are required');
    }

    const existingDriver = await getDriverById(req.user.id);
    if (existingDriver) {
      throw new HttpError(409, 'Driver already registered');
    }

    await dbRun('UPDATE users SET name = ?, role = ? WHERE id = ?', [
      name,
      'driver',
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
    next(error);
  }
});

app.post('/api/orders', authenticate, async (req, res, next) => {
  try {
    const { pickup, dropoff } = req.body || {};
    if (!pickup || !dropoff) {
      throw new HttpError(400, 'Pickup and dropoff locations are required');
    }

    const quote = await quoteTrip(pickup, dropoff);

    const insert = await dbRun(
      `INSERT INTO orders (customer_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, price, distance_km, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        pickup.lat,
        pickup.lng,
        dropoff.lat,
        dropoff.lng,
        quote.price,
        quote.distanceKm,
        ORDER_STATUS.CREATED
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
      `SELECT u.id, u.name, u.phone_number, d.vehicle_type, d.license_plate, d.verified, d.availability_status
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
      availabilityStatus: row.availability_status
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

// --- Socket.IO Authentication ---
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token || !sessionStore.has(token)) {
      throw new Error('Unauthorized');
    }
    const userId = sessionStore.get(token);
    const user = await getUserById(userId);
    if (!user) {
      sessionStore.delete(token);
      throw new Error('Unauthorized');
    }
    socket.data.userId = userId;
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
      console.log(`Allowed CORS origins: ${allowList.length ? allowList.join(', ') : 'none'}`);
    });
  } catch (error) {
    console.error('Failed to start server', error);
    process.exit(1);
  }
}

bootstrap();
