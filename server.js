const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const http = require('http');
const { Server } = require('socket.io');
const { Client } = require('@googlemaps/google-maps-services-js');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']
    }
});

// --- Third-party configuration ---
// IMPORTANT: keys and secrets should live in environment variables in production.
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'YOUR_GOOGLE_MAPS_API_KEY'; // TODO: move to env var
const googleMapsClient = new Client({});

const ADMIN_SECRET_KEY = process.env.ADMIN_PASSWORD || 'supersecretpassword123'; // TODO: move to env var
let adminToken = null;

const accountSid = process.env.TWILIO_ACCOUNT_SID || 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // TODO: move to env var
const authToken = process.env.TWILIO_AUTH_TOKEN || 'your_twilio_auth_token'; // TODO: move to env var
const twilioClient = require('twilio')(accountSid, authToken);
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER || '+15017122661'; // TODO: move to env var

const otpStore = {}; // { phoneNumber: { code, expires } }
const sessionStore = {}; // { token: userId }

const ORDER_ACTIVE_STATUSES = ['SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'PICKED_UP'];
const driverSockets = new Map(); // driverId -> socket instance
const customerSockets = new Map(); // customerId -> socket instance

const db = new sqlite3.Database('./delivery_app.db', (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        db.serialize(() => {
            db.run(`CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phone_number TEXT UNIQUE NOT NULL,
                name TEXT,
                role TEXT DEFAULT 'customer',
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS drivers (
                user_id INTEGER PRIMARY KEY NOT NULL,
                vehicle_type TEXT NOT NULL,
                license_plate TEXT,
                verified BOOLEAN DEFAULT 0,
                availability_status TEXT DEFAULT 'offline',
                last_lat REAL,
                last_lng REAL,
                FOREIGN KEY (user_id) REFERENCES users (id)
            )`);

            db.run(`CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                customer_id INTEGER NOT NULL,
                driver_id INTEGER,
                pickup_lat REAL NOT NULL,
                pickup_lng REAL NOT NULL,
                dropoff_lat REAL NOT NULL,
                dropoff_lng REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'SEARCHING_DRIVER',
                price REAL,
                distance_km REAL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (customer_id) REFERENCES users (id),
                FOREIGN KEY (driver_id) REFERENCES drivers (user_id)
            )`);
        });

        ensureColumnExists('orders', 'driver_id', 'driver_id INTEGER');
        ensureColumnExists('orders', 'distance_km', 'distance_km REAL');
        ensureColumnExists('orders', 'price', 'price REAL');
        ensureColumnExists('orders', 'status', "status TEXT NOT NULL DEFAULT 'SEARCHING_DRIVER'");
        ensureColumnExists('drivers', 'availability_status', "availability_status TEXT DEFAULT 'offline'");
        ensureColumnExists('drivers', 'last_lat', 'last_lat REAL');
        ensureColumnExists('drivers', 'last_lng', 'last_lng REAL');
    }
});

function ensureColumnExists(table, column, definition) {
    db.all(`PRAGMA table_info(${table})`, (err, rows) => {
        if (err) {
            console.error(`Failed to inspect schema for ${table}:`, err.message);
            return;
        }
        const exists = rows.some((row) => row.name === column);
        if (!exists) {
            db.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`, (alterErr) => {
                if (alterErr) {
                    console.error(`Failed to add column ${column} to ${table}:`, alterErr.message);
                } else {
                    console.log(`Added missing column ${column} to ${table}.`);
                }
            });
        }
    });
}

function createSessionToken(userId) {
    const token = crypto.randomBytes(32).toString('hex');
    sessionStore[token] = userId;
    return token;
}

function getOrderDetails(orderId, callback) {
    const sql = `
        SELECT o.id, o.customer_id, o.driver_id, o.pickup_lat, o.pickup_lng,
               o.dropoff_lat, o.dropoff_lng, o.status, o.price, o.distance_km,
               o.created_at,
               du.name AS driver_name, du.phone_number AS driver_phone,
               d.vehicle_type, d.license_plate,
               cu.name AS customer_name, cu.phone_number AS customer_phone
        FROM orders o
        LEFT JOIN drivers d ON o.driver_id = d.user_id
        LEFT JOIN users du ON d.user_id = du.id
        LEFT JOIN users cu ON o.customer_id = cu.id
        WHERE o.id = ?
    `;

    db.get(sql, [orderId], (err, order) => {
        if (err) {
            callback(err);
            return;
        }
        if (!order) {
            callback(null, null);
            return;
        }

        const payload = {
            id: order.id,
            customer: {
                id: order.customer_id,
                name: order.customer_name || '',
                phoneNumber: order.customer_phone || ''
            },
            status: order.status,
            price: order.price !== null ? Number(order.price) : null,
            distanceKm: order.distance_km !== null ? Number(order.distance_km) : null,
            pickup: { lat: Number(order.pickup_lat), lng: Number(order.pickup_lng) },
            dropoff: { lat: Number(order.dropoff_lat), lng: Number(order.dropoff_lng) },
            createdAt: order.created_at,
            driver: order.driver_id ? {
                id: order.driver_id,
                name: order.driver_name || '',
                phoneNumber: order.driver_phone || '',
                vehicleType: order.vehicle_type || '',
                licensePlate: order.license_plate || ''
            } : null
        };

        callback(null, payload);
    });
}

function emitOrderStatus(orderId) {
    getOrderDetails(orderId, (err, details) => {
        if (err) {
            console.error('Failed to load order details for broadcast:', err.message);
            return;
        }
        if (!details) {
            return;
        }

        io.to(`order_${orderId}`).emit('order:status_update', details);

        const customerSocket = customerSockets.get(details.customer.id);
        if (customerSocket) {
            customerSocket.emit('order:status_update', details);
        }

        if (details.driver) {
            const driverSocket = driverSockets.get(details.driver.id);
            if (driverSocket) {
                driverSocket.emit('order:status_update', details);
                if (details.status === 'DRIVER_ASSIGNED') {
                    driverSocket.emit('order:assigned', details);
                }
            }
        }
    });
}

function assignPendingOrders() {
    db.all(`SELECT id FROM orders WHERE status = 'SEARCHING_DRIVER' ORDER BY created_at ASC`, (err, rows) => {
        if (err) {
            console.error('Failed to fetch pending orders:', err.message);
            return;
        }
        rows.forEach((row) => tryAssignDriver(row.id));
    });
}

function tryAssignDriver(orderId) {
    const sqlOrder = `SELECT id, status FROM orders WHERE id = ?`;
    db.get(sqlOrder, [orderId], (orderErr, order) => {
        if (orderErr) {
            console.error('Failed to load order for assignment:', orderErr.message);
            return;
        }
        if (!order || order.status !== 'SEARCHING_DRIVER') {
            return;
        }

        const sqlDriver = `
            SELECT u.id AS user_id
            FROM drivers d
            JOIN users u ON u.id = d.user_id
            WHERE d.verified = 1 AND d.availability_status = 'online'
            ORDER BY d.last_lat IS NULL, d.last_lng IS NULL, u.created_at ASC
            LIMIT 1
        `;

        db.get(sqlDriver, [], (driverErr, driver) => {
            if (driverErr) {
                console.error('Failed to fetch available driver:', driverErr.message);
                return;
            }
            if (!driver) {
                return;
            }

            db.serialize(() => {
                db.run('BEGIN TRANSACTION;');
                db.run(
                    "UPDATE orders SET driver_id = ?, status = 'DRIVER_ASSIGNED' WHERE id = ? AND status = 'SEARCHING_DRIVER'",
                    [driver.user_id, orderId],
                    function (updateErr) {
                        if (updateErr || this.changes === 0) {
                            if (updateErr) {
                                console.error('Failed to assign driver to order:', updateErr.message);
                            }
                            db.run('ROLLBACK;');
                            return;
                        }

                        db.run(
                            "UPDATE drivers SET availability_status = 'busy' WHERE user_id = ?",
                            [driver.user_id],
                            (statusErr) => {
                                if (statusErr) {
                                    console.error('Failed to mark driver busy:', statusErr.message);
                                    db.run('ROLLBACK;');
                                    return;
                                }

                                db.run('COMMIT;', (commitErr) => {
                                    if (commitErr) {
                                        console.error('Commit error while assigning driver:', commitErr.message);
                                        return;
                                    }

                                    const driverSocket = driverSockets.get(driver.user_id);
                                    if (driverSocket) {
                                        driverSocket.join(`order_${orderId}`);
                                    }
                                    emitOrderStatus(orderId);
                                });
                            }
                        );
                    }
                );
            });
        });
    });
}

function hasActiveDriverOrder(driverId, callback) {
    const sql = `SELECT COUNT(*) AS total FROM orders WHERE driver_id = ? AND status IN ('DRIVER_ASSIGNED', 'PICKED_UP')`;
    db.get(sql, [driverId], (err, row) => {
        if (err) {
            callback(err);
        } else {
            callback(null, row.total > 0);
        }
    });
}

// --- Authentication Endpoints ---
app.post('/api/auth/request-otp', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Phone number is required.' });
    }

    const otpCode = Math.floor(1000 + Math.random() * 9000).toString();
    const expires = Date.now() + 5 * 60 * 1000;
    otpStore[phoneNumber] = { code: otpCode, expires };
    console.log(`Generated OTP for ${phoneNumber}: ${otpCode}`);

    try {
        await twilioClient.messages.create({
            body: `رمز التحقق الخاص بك في تطبيق وصلني هو: ${otpCode}`,
            from: twilioPhoneNumber,
            to: phoneNumber
        });
        res.status(200).json({ success: true, message: 'OTP sent successfully.' });
    } catch (error) {
        console.error('Error sending SMS:', error.message);
        if (error.code === 20003) {
            console.log('Twilio auth failed, returning simulated success for local testing.');
            return res.status(200).json({ success: true, message: 'OTP sent successfully (Simulated).' });
        }
        res.status(500).json({ error: 'Failed to send OTP.' });
    }
});

app.post('/api/auth/verify-otp', (req, res) => {
    const { phoneNumber, otpCode } = req.body;
    if (!phoneNumber || !otpCode) {
        return res.status(400).json({ error: 'Phone number and OTP are required.' });
    }

    const storedOtp = otpStore[phoneNumber];
    if (!storedOtp || storedOtp.code !== otpCode || Date.now() > storedOtp.expires) {
        return res.status(400).json({ error: 'Invalid or expired OTP.' });
    }

    delete otpStore[phoneNumber];

    db.get('SELECT * FROM users WHERE phone_number = ?', [phoneNumber], (err, user) => {
        if (err) {
            console.error('Database error while verifying OTP:', err.message);
            return res.status(500).json({ error: 'Database error.' });
        }

        const completeLogin = (userId, role, isDriverVerified) => {
            const token = createSessionToken(userId);
            res.status(200).json({
                success: true,
                message: 'Login successful!',
                token,
                role,
                isDriverVerified
            });
        };

        if (user) {
            db.get('SELECT verified FROM drivers WHERE user_id = ?', [user.id], (driverErr, driver) => {
                if (driverErr) {
                    console.error('Database error while reading driver info:', driverErr.message);
                    return res.status(500).json({ error: 'Database error.' });
                }
                completeLogin(user.id, user.role, driver ? !!driver.verified : null);
            });
        } else {
            db.run('INSERT INTO users (phone_number) VALUES (?)', [phoneNumber], function (insertErr) {
                if (insertErr) {
                    console.error('Failed to create user record:', insertErr.message);
                    return res.status(500).json({ error: 'Failed to create user.' });
                }
                completeLogin(this.lastID, 'customer', null);
            });
        }
    });
});

const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token || !sessionStore[token]) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    req.userId = sessionStore[token];
    next();
};

// --- Driver Management ---
app.post('/api/drivers/register', authenticate, (req, res) => {
    const userId = req.userId;
    const { name, vehicleType, licensePlate } = req.body;

    if (!name || !vehicleType || !licensePlate) {
        return res.status(400).json({ error: 'Name, vehicle type, and license plate are required.' });
    }

    db.get('SELECT * FROM drivers WHERE user_id = ?', [userId], (err, driver) => {
        if (err) {
            console.error('Database error while checking driver registration:', err.message);
            return res.status(500).json({ error: 'Database error.' });
        }
        if (driver) {
            return res.status(409).json({ error: 'This user is already registered as a driver.' });
        }

        db.serialize(() => {
            db.run('BEGIN TRANSACTION;');

            db.run(`UPDATE users SET name = ?, role = 'driver' WHERE id = ?`, [name, userId], (updateUserErr) => {
                if (updateUserErr) {
                    console.error('Failed to update user role to driver:', updateUserErr.message);
                    db.run('ROLLBACK;');
                    return res.status(500).json({ error: 'Failed to register driver.' });
                }

                const driverSql = `INSERT INTO drivers (user_id, vehicle_type, license_plate) VALUES (?, ?, ?)`;
                db.run(driverSql, [userId, vehicleType, licensePlate], (driverInsertErr) => {
                    if (driverInsertErr) {
                        console.error('Driver registration error:', driverInsertErr.message);
                        db.run('ROLLBACK;');
                        return res.status(500).json({ error: 'Failed to register driver.' });
                    }

                    db.run('COMMIT;', (commitErr) => {
                        if (commitErr) {
                            console.error('Commit error during driver registration:', commitErr.message);
                            return res.status(500).json({ error: 'Failed to register driver.' });
                        }
                        res.status(201).json({ success: true, message: 'Driver registration submitted successfully. Waiting for approval.' });
                    });
                });
            });
        });
    });
});

app.get('/api/drivers/me', authenticate, (req, res) => {
    const userId = req.userId;
    db.get('SELECT id, phone_number, name, role FROM users WHERE id = ?', [userId], (userErr, user) => {
        if (userErr) {
            console.error('Failed to load user profile:', userErr.message);
            return res.status(500).json({ error: 'Database error.' });
        }
        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        db.get('SELECT user_id, vehicle_type, license_plate, verified, availability_status FROM drivers WHERE user_id = ?', [userId], (driverErr, driver) => {
            if (driverErr) {
                console.error('Failed to load driver profile:', driverErr.message);
                return res.status(500).json({ error: 'Database error.' });
            }

            res.status(200).json({
                success: true,
                user,
                driver: driver ? {
                    userId: driver.user_id,
                    vehicleType: driver.vehicle_type,
                    licensePlate: driver.license_plate,
                    verified: !!driver.verified,
                    availabilityStatus: driver.availability_status
                } : null
            });
        });
    });
});

app.post('/api/drivers/status', authenticate, (req, res) => {
    const userId = req.userId;
    const { status } = req.body;

    if (!status || !['online', 'offline'].includes(status)) {
        return res.status(400).json({ error: 'Status must be "online" or "offline".' });
    }

    db.get('SELECT verified FROM drivers WHERE user_id = ?', [userId], (driverErr, driver) => {
        if (driverErr) {
            console.error('Failed to read driver status:', driverErr.message);
            return res.status(500).json({ error: 'Database error.' });
        }
        if (!driver) {
            return res.status(404).json({ error: 'Driver profile not found.' });
        }
        if (!driver.verified) {
            return res.status(403).json({ error: 'Driver is not verified yet.' });
        }

        const proceedUpdate = () => {
            db.run('UPDATE drivers SET availability_status = ? WHERE user_id = ?', [status, userId], (updateErr) => {
                if (updateErr) {
                    console.error('Failed to update driver availability:', updateErr.message);
                    return res.status(500).json({ error: 'Failed to update status.' });
                }
                if (status === 'online') {
                    assignPendingOrders();
                }
                res.status(200).json({ success: true, status });
            });
        };

        if (status === 'offline') {
            hasActiveDriverOrder(userId, (activeErr, hasActive) => {
                if (activeErr) {
                    console.error('Failed to validate driver active orders:', activeErr.message);
                    return res.status(500).json({ error: 'Database error.' });
                }
                if (hasActive) {
                    return res.status(400).json({ error: 'Cannot go offline while delivering an order.' });
                }
                proceedUpdate();
            });
        } else {
            proceedUpdate();
        }
    });
});

app.get('/api/drivers/active-order', authenticate, (req, res) => {
    const driverId = req.userId;
    const sql = `SELECT id FROM orders WHERE driver_id = ? AND status IN ('DRIVER_ASSIGNED', 'PICKED_UP') ORDER BY created_at DESC LIMIT 1`;
    db.get(sql, [driverId], (err, row) => {
        if (err) {
            console.error('Failed to fetch active driver order:', err.message);
            return res.status(500).json({ error: 'Database error.' });
        }
        if (!row) {
            return res.status(200).json(null);
        }
        getOrderDetails(row.id, (detailsErr, details) => {
            if (detailsErr) {
                console.error('Failed to load order details:', detailsErr.message);
                return res.status(500).json({ error: 'Database error.' });
            }
            res.status(200).json(details);
        });
    });
});

// --- Orders & Quotes ---
app.post('/api/quote', authenticate, async (req, res) => {
    const { pickup, dropoff } = req.body;
    if (!pickup || !dropoff) {
        return res.status(400).json({ error: 'Pickup and dropoff locations are required.' });
    }

    try {
        const directionsResponse = await googleMapsClient.directions({
            params: {
                origin: pickup,
                destination: dropoff,
                key: GOOGLE_MAPS_API_KEY,
                mode: 'DRIVING'
            },
            timeout: 5000
        });

        if (!directionsResponse.data.routes.length) {
            return res.status(404).json({ error: 'Could not find a route.' });
        }

        const route = directionsResponse.data.routes[0].legs[0];
        const distanceKm = route.distance.value / 1000;
        const durationMin = route.duration.value / 60;

        const baseFare = 20;
        const perKmRate = 4;
        const price = baseFare + distanceKm * perKmRate;

        res.status(200).json({
            distanceKm: Number(distanceKm.toFixed(2)),
            durationMin: Number(durationMin.toFixed(0)),
            price: Number(price.toFixed(2))
        });
    } catch (e) {
        console.error('Google Maps API error while quoting:', e.message);
        res.status(500).json({ error: 'Failed to calculate quote.' });
    }
});

app.post('/api/orders', authenticate, async (req, res) => {
    const { pickup, dropoff } = req.body;
    const customerId = req.userId;

    if (!pickup || !dropoff) {
        return res.status(400).json({ error: 'Pickup and dropoff locations are required.' });
    }

    try {
        const directionsResponse = await googleMapsClient.directions({
            params: {
                origin: pickup,
                destination: dropoff,
                key: GOOGLE_MAPS_API_KEY,
                mode: 'DRIVING'
            },
            timeout: 5000
        });

        if (!directionsResponse.data.routes.length) {
            return res.status(404).json({ error: 'Could not find a route to create order.' });
        }

        const route = directionsResponse.data.routes[0].legs[0];
        const distanceKm = route.distance.value / 1000;
        const baseFare = 20;
        const perKmRate = 4;
        const price = baseFare + distanceKm * perKmRate;

        const sql = `
            INSERT INTO orders (customer_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, price, distance_km, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'SEARCHING_DRIVER')
        `;
        const params = [
            customerId,
            pickup.lat,
            pickup.lng,
            dropoff.lat,
            dropoff.lng,
            Number(price.toFixed(2)),
            Number(distanceKm.toFixed(2))
        ];

        db.run(sql, params, function (err) {
            if (err) {
                console.error('Failed to create order:', err.message);
                return res.status(500).json({ error: 'Failed to create order.' });
            }

            const orderResponse = {
                id: this.lastID,
                customerId,
                pickup,
                dropoff,
                price: Number(price.toFixed(2)),
                distanceKm: Number(distanceKm.toFixed(2)),
                status: 'SEARCHING_DRIVER'
            };

            res.status(201).json(orderResponse);
            tryAssignDriver(this.lastID);
        });
    } catch (e) {
        console.error('Google Maps API error on order creation:', e.message);
        res.status(500).json({ error: 'Failed to create order due to maps service error.' });
    }
});

app.post('/api/orders/:id/cancel', authenticate, (req, res) => {
    const orderId = Number(req.params.id);
    if (!orderId) {
        return res.status(400).json({ error: 'Invalid order id.' });
    }

    db.get('SELECT * FROM orders WHERE id = ? AND customer_id = ?', [orderId, req.userId], (err, order) => {
        if (err) {
            console.error('Failed to load order for cancellation:', err.message);
            return res.status(500).json({ error: 'Database error.' });
        }
        if (!order) {
            return res.status(404).json({ error: 'Order not found.' });
        }
        if (!['SEARCHING_DRIVER', 'DRIVER_ASSIGNED'].includes(order.status)) {
            return res.status(400).json({ error: 'Order can no longer be cancelled.' });
        }

        db.serialize(() => {
            db.run('BEGIN TRANSACTION;');
            db.run('UPDATE orders SET status = "CANCELLED" WHERE id = ?', [orderId], (updateErr) => {
                if (updateErr) {
                    console.error('Failed to cancel order:', updateErr.message);
                    db.run('ROLLBACK;');
                    return res.status(500).json({ error: 'Failed to cancel order.' });
                }

                const finalize = () => {
                    db.run('COMMIT;', (commitErr) => {
                        if (commitErr) {
                            console.error('Commit error during cancellation:', commitErr.message);
                            return res.status(500).json({ error: 'Failed to cancel order.' });
                        }
                        res.status(200).json({ success: true });
                        emitOrderStatus(orderId);
                        assignPendingOrders();
                    });
                };

                if (order.driver_id) {
                    db.run('UPDATE drivers SET availability_status = "online" WHERE user_id = ?', [order.driver_id], (driverErr) => {
                        if (driverErr) {
                            console.error('Failed to release driver after cancellation:', driverErr.message);
                            db.run('ROLLBACK;');
                            return res.status(500).json({ error: 'Failed to cancel order.' });
                        }
                        finalize();
                    });
                } else {
                    finalize();
                }
            });
        });
    });
});

app.get('/api/orders/history', authenticate, (req, res) => {
    const customerId = req.userId;
    const sql = `SELECT id, status, price, distance_km, created_at FROM orders WHERE customer_id = ? ORDER BY created_at DESC`;
    db.all(sql, [customerId], (err, rows) => {
        if (err) {
            console.error('Failed to retrieve order history:', err.message);
            return res.status(500).json({ error: 'Failed to retrieve order history.' });
        }
        const formatted = rows.map((row) => ({
            id: row.id,
            status: row.status,
            price: row.price !== null ? Number(row.price) : null,
            distanceKm: row.distance_km !== null ? Number(row.distance_km) : null,
            createdAt: row.created_at
        }));
        res.status(200).json(formatted);
    });
});

app.get('/api/orders/active', authenticate, (req, res) => {
    const sql = `
        SELECT id FROM orders
        WHERE customer_id = ? AND status IN ('SEARCHING_DRIVER', 'DRIVER_ASSIGNED', 'PICKED_UP')
        ORDER BY created_at DESC
        LIMIT 1
    `;
    db.get(sql, [req.userId], (err, row) => {
        if (err) {
            console.error('Failed to fetch active order:', err.message);
            return res.status(500).json({ error: 'Database error.' });
        }
        if (!row) {
            return res.status(200).json(null);
        }
        getOrderDetails(row.id, (detailsErr, details) => {
            if (detailsErr) {
                console.error('Failed to load active order details:', detailsErr.message);
                return res.status(500).json({ error: 'Database error.' });
            }
            res.status(200).json(details);
        });
    });
});

// --- Admin Endpoints ---
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_SECRET_KEY) {
        adminToken = crypto.randomBytes(32).toString('hex');
        res.status(200).json({ success: true, token: adminToken });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (token && token === adminToken) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized Admin' });
    }
};

app.get('/api/admin/drivers', authenticateAdmin, (req, res) => {
    const sql = `
        SELECT u.id, u.name, u.phone_number, d.vehicle_type, d.license_plate, d.verified, d.availability_status
        FROM users u
        JOIN drivers d ON u.id = d.user_id
        ORDER BY d.verified ASC, u.created_at DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error('Failed to retrieve drivers:', err.message);
            return res.status(500).json({ error: 'Failed to retrieve drivers.' });
        }
        const formatted = rows.map((row) => ({
            id: row.id,
            name: row.name,
            phoneNumber: row.phone_number,
            vehicleType: row.vehicle_type,
            licensePlate: row.license_plate,
            verified: !!row.verified,
            availabilityStatus: row.availability_status
        }));
        res.status(200).json(formatted);
    });
});

app.post('/api/admin/drivers/:id/verify', authenticateAdmin, (req, res) => {
    const driverId = Number(req.params.id);
    const { verified } = req.body;

    if (typeof verified !== 'boolean') {
        return res.status(400).json({ error: 'A boolean "verified" status is required.' });
    }

    db.run('UPDATE drivers SET verified = ? WHERE user_id = ?', [verified ? 1 : 0, driverId], function (err) {
        if (err) {
            console.error('Failed to update driver verification:', err.message);
            return res.status(500).json({ error: 'Failed to update driver status.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Driver not found.' });
        }
        if (!verified) {
            db.run('UPDATE drivers SET availability_status = "offline" WHERE user_id = ?', [driverId]);
        }
        res.status(200).json({ success: true, message: 'Driver status updated.' });
        if (verified) {
            assignPendingOrders();
        }
    });
});

// --- Socket.IO Authentication ---
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token || !sessionStore[token]) {
        return next(new Error('Unauthorized'));
    }
    const userId = sessionStore[token];
    db.get('SELECT role FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return next(new Error('Unauthorized'));
        }
        socket.data.userId = userId;
        socket.data.role = user.role;
        next();
    });
});

io.on('connection', (socket) => {
    const userId = socket.data.userId;
    const role = socket.data.role;

    if (role === 'driver') {
        driverSockets.set(userId, socket);
    } else {
        customerSockets.set(userId, socket);
    }

    socket.on('order:join', ({ orderId }) => {
        if (!orderId) {
            return;
        }
        db.get('SELECT customer_id, driver_id FROM orders WHERE id = ?', [orderId], (err, order) => {
            if (err || !order) {
                return;
            }
            if (order.customer_id === userId || order.driver_id === userId) {
                socket.join(`order_${orderId}`);
                getOrderDetails(orderId, (detailsErr, details) => {
                    if (!detailsErr && details) {
                        socket.emit('order:status_update', details);
                    }
                });
            }
        });
    });

    if (role === 'driver') {
        socket.on('driver:send_location', (payload) => {
            const { lat, lng } = payload || {};
            if (typeof lat !== 'number' || typeof lng !== 'number') {
                return;
            }
            db.run('UPDATE drivers SET last_lat = ?, last_lng = ? WHERE user_id = ?', [lat, lng, userId], (err) => {
                if (err) {
                    console.error('Failed to update driver location:', err.message);
                }
            });
            db.all('SELECT id FROM orders WHERE driver_id = ? AND status IN ("DRIVER_ASSIGNED", "PICKED_UP")', [userId], (err, rows) => {
                if (err) {
                    console.error('Failed to fetch orders for location broadcast:', err.message);
                    return;
                }
                rows.forEach((row) => {
                    io.to(`order_${row.id}`).emit('driver:location_update', {
                        orderId: row.id,
                        driverId: userId,
                        lat,
                        lng,
                        updatedAt: new Date().toISOString()
                    });
                });
            });
        });

        socket.on('driver:update_status', ({ orderId, status }) => {
            if (!orderId || !status || !['PICKED_UP', 'DELIVERED'].includes(status)) {
                return;
            }
            db.get('SELECT status FROM orders WHERE id = ? AND driver_id = ?', [orderId, userId], (err, order) => {
                if (err || !order) {
                    return;
                }

                const allowedTransitions = {
                    DRIVER_ASSIGNED: ['PICKED_UP'],
                    PICKED_UP: ['DELIVERED']
                };
                const allowed = allowedTransitions[order.status] || [];
                if (!allowed.includes(status)) {
                    return;
                }

                db.run('UPDATE orders SET status = ? WHERE id = ?', [status, orderId], (updateErr) => {
                    if (updateErr) {
                        console.error('Failed to update order status:', updateErr.message);
                        return;
                    }

                    if (status === 'DELIVERED') {
                        db.run('UPDATE drivers SET availability_status = "online" WHERE user_id = ?', [userId], (driverErr) => {
                            if (driverErr) {
                                console.error('Failed to set driver online after delivery:', driverErr.message);
                            }
                            emitOrderStatus(orderId);
                            assignPendingOrders();
                        });
                    } else {
                        emitOrderStatus(orderId);
                    }
                });
            });
        });
    }

    socket.on('disconnect', () => {
        if (role === 'driver') {
            driverSockets.delete(userId);
            hasActiveDriverOrder(userId, (err, hasActive) => {
                if (err) {
                    console.error('Failed to verify driver active orders on disconnect:', err.message);
                    return;
                }
                if (!hasActive) {
                    db.run('UPDATE drivers SET availability_status = "offline" WHERE user_id = ?', [userId], (updateErr) => {
                        if (updateErr) {
                            console.error('Failed to set driver offline on disconnect:', updateErr.message);
                        }
                    });
                }
            });
        } else {
            customerSockets.delete(userId);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
