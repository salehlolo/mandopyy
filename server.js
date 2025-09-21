require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const FacebookStrategy = require('passport-facebook').Strategy;

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
  corsOrigins: (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  searchRadiusKm: Number(process.env.SEARCH_RADIUS_KM || 7),
  baseUrl: process.env.BASE_URL || `http://localhost:${rawPort}`,
  frontendUrl: process.env.FRONTEND_URL || `http://localhost:${rawPort}`,
  jwtSecret: process.env.JWT_SECRET || 'change-me',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  facebookAppId: process.env.FACEBOOK_APP_ID || '',
  facebookAppSecret: process.env.FACEBOOK_APP_SECRET || ''
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
app.use(
  session({
    secret: CONFIG.jwtSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    }
  })
);
app.use(passport.initialize());
app.use(passport.session());

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
  await ensureColumn('drivers', 'availability_status', "availability_status TEXT DEFAULT 'offline'");
  await ensureColumn('drivers', 'last_lat', 'last_lat REAL');
  await ensureColumn('drivers', 'last_lng', 'last_lng REAL');
}


const driverSockets = new Map();
const customerSockets = new Map();
let adminToken = null;

function normaliseEmail(value) {
  return (value || '').trim().toLowerCase();
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

async function getUserById(userId) {
  return dbGet('SELECT * FROM users WHERE id = ?', [userId]);
}

async function findUserByEmail(email) {
  if (!email) {
    return null;
  }
  return dbGet('SELECT * FROM users WHERE email = ?', [email]);
}

async function upsertOAuthUser({ provider, sub, email, name }) {
  if (!provider || !sub) {
    throw new Error('OAuth payload missing provider or subject');
  }
  const existingBySub = await dbGet(
    'SELECT * FROM users WHERE oauth_provider = ? AND oauth_sub = ?',
    [provider, sub]
  );
  if (existingBySub) {
    if (email && !existingBySub.email) {
      await dbRun('UPDATE users SET email = ? WHERE id = ?', [email, existingBySub.id]);
    }
    if (name && !existingBySub.name) {
      await dbRun('UPDATE users SET name = ? WHERE id = ?', [name, existingBySub.id]);
    }
    return getUserById(existingBySub.id);
  }

  if (email) {
    const existingByEmail = await findUserByEmail(email);
    if (existingByEmail) {
      await dbRun(
        'UPDATE users SET oauth_provider = ?, oauth_sub = ? WHERE id = ?',
        [provider, sub, existingByEmail.id]
      );
      if (name && !existingByEmail.name) {
        await dbRun('UPDATE users SET name = ? WHERE id = ?', [name, existingByEmail.id]);
      }
      return getUserById(existingByEmail.id);
    }
  }

  const insert = await dbRun(
    'INSERT INTO users (email, name, role, oauth_provider, oauth_sub) VALUES (?, ?, ?, ?, ?)',
    [email || null, name || '', 'customer', provider, sub]
  );
  return getUserById(insert.lastID);
}

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const user = await getUserById(id);
    done(null, user);
  } catch (error) {
    done(error);
  }
});

if (CONFIG.googleClientId && CONFIG.googleClientSecret) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: CONFIG.googleClientId,
        clientSecret: CONFIG.googleClientSecret,
        callbackURL: `${CONFIG.baseUrl}/v1/auth/google/callback`
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const primaryEmail = profile.emails?.[0]?.value;
          const user = await upsertOAuthUser({
            provider: 'google',
            sub: profile.id,
            email: primaryEmail ? normaliseEmail(primaryEmail) : null,
            name: profile.displayName
          });
          done(null, user);
        } catch (error) {
          done(error);
        }
      }
    )
  );
} else {
  console.warn('Google OAuth credentials are not configured; Google login is disabled.');
}

if (CONFIG.facebookAppId && CONFIG.facebookAppSecret) {
  passport.use(
    new FacebookStrategy(
      {
        clientID: CONFIG.facebookAppId,
        clientSecret: CONFIG.facebookAppSecret,
        callbackURL: `${CONFIG.baseUrl}/v1/auth/facebook/callback`,
        profileFields: ['id', 'displayName', 'emails']
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const primaryEmail = profile.emails?.[0]?.value;
          const user = await upsertOAuthUser({
            provider: 'facebook',
            sub: profile.id,
            email: primaryEmail ? normaliseEmail(primaryEmail) : null,
            name: profile.displayName
          });
          done(null, user);
        } catch (error) {
          done(error);
        }
      }
    )
  );
} else {
  console.warn('Facebook OAuth credentials are not configured; Facebook login is disabled.');
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
    price: Number(price.toFixed(2))
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
    GOOGLE_MAPS_API_KEY: CONFIG.googleMapsApiKey,
    MAP_PROVIDER: CONFIG.mapProvider,
    OSM_ROUTING_URL: CONFIG.osmRoutingUrl,
    NOMINATIM_URL: CONFIG.nominatimUrl,
    MAPTILER_KEY: CONFIG.maptilerKey,
    MAPBOX_TOKEN: CONFIG.mapboxToken
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
app.post('/v1/auth/register', async (req, res, next) => {
  try {
    const { email, password, name } = req.body || {};
    const normalisedEmail = normaliseEmail(email);
    if (!normalisedEmail) {
      throw new HttpError(400, 'Email is required');
    }
    if (!password || password.length < 6) {
      throw new HttpError(400, 'Password must be at least 6 characters long');
    }

    const existing = await findUserByEmail(normalisedEmail);
    if (existing) {
      throw new HttpError(409, 'Email is already registered');
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const insert = await dbRun(
      'INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)',
      [normalisedEmail, passwordHash, name || '', 'customer']
    );
    const user = await getUserById(insert.lastID);
    const token = signUserToken(user);
    res.status(201).json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post('/v1/auth/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const normalisedEmail = normaliseEmail(email);
    if (!normalisedEmail || !password) {
      throw new HttpError(400, 'Email and password are required');
    }
    const user = await findUserByEmail(normalisedEmail);
    if (!user || !user.password_hash) {
      throw new HttpError(400, 'Invalid credentials');
    }
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      throw new HttpError(400, 'Invalid credentials');
    }
    const token = signUserToken(user);
    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role
      }
    });
  } catch (error) {
    next(error);
  }
});

if (CONFIG.googleClientId && CONFIG.googleClientSecret) {
  app.get('/v1/auth/google', (req, res, next) => {
    const state = req.query.state;
    passport.authenticate('google', {
      scope: ['profile', 'email'],
      state
    })(req, res, next);
  });
  app.get(
    '/v1/auth/google/callback',
    passport.authenticate('google', {
      failureRedirect: `${CONFIG.frontendUrl}/#login_error`
    }),
    (req, res) => {
      const redirectState = req.query.state;
      const base = CONFIG.frontendUrl.replace(/\/$/, '');
      const target = redirectState === 'driver' ? `${base}/driver_app.html` : base;
      const token = signUserToken(req.user);
      res.redirect(`${target}#token=${encodeURIComponent(token)}`);
    }
  );
} else {
  app.get('/v1/auth/google', (req, res) => {
    res.status(503).json({ message: 'Google login is not configured' });
  });
  app.get('/v1/auth/google/callback', (req, res) => {
    const redirectState = req.query.state;
    const base = CONFIG.frontendUrl.replace(/\/$/, '');
    const target = redirectState === 'driver' ? `${base}/driver_app.html` : base;
    res.redirect(`${target}#login_error`);
  });
}

if (CONFIG.facebookAppId && CONFIG.facebookAppSecret) {
  app.get('/v1/auth/facebook', (req, res, next) => {
    const state = req.query.state;
    passport.authenticate('facebook', { scope: ['email'], state })(req, res, next);
  });
  app.get(
    '/v1/auth/facebook/callback',
    passport.authenticate('facebook', {
      failureRedirect: `${CONFIG.frontendUrl}/#login_error`
    }),
    (req, res) => {
      const redirectState = req.query.state;
      const base = CONFIG.frontendUrl.replace(/\/$/, '');
      const target = redirectState === 'driver' ? `${base}/driver_app.html` : base;
      const token = signUserToken(req.user);
      res.redirect(`${target}#token=${encodeURIComponent(token)}`);
    }
  );
} else {
  app.get('/v1/auth/facebook', (req, res) => {
    res.status(503).json({ message: 'Facebook login is not configured' });
  });
  app.get('/v1/auth/facebook/callback', (req, res) => {
    const redirectState = req.query.state;
    const base = CONFIG.frontendUrl.replace(/\/$/, '');
    const target = redirectState === 'driver' ? `${base}/driver_app.html` : base;
    res.redirect(`${target}#login_error`);
  });
}

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
