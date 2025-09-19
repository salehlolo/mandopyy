// هذا مثال توضيحي باستخدام Node.js و Express
// لتشغيله، ستحتاج لتثبيت الحزم التالية: npm install express twilio cors sqlite3 crypto @googlemaps/google-maps-services-js

const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto'); // لإنشاء توكن عشوائي
const { Client } = require("@googlemaps/google-maps-services-js");

const app = express();
app.use(cors());
app.use(express.json());

// --- إعدادات Google Maps ---
// هام: هذا المفتاح سري. في تطبيق حقيقي، يجب حفظه كمتغير بيئة.
const GOOGLE_MAPS_API_KEY = "YOUR_GOOGLE_MAPS_API_KEY"; // <-- ضع مفتاح API الخاص بك هنا
const googleMapsClient = new Client({});

// --- إعدادات المشرف (Admin) ---
const ADMIN_SECRET_KEY = "supersecretpassword123"; // كلمة سر المشرف (تغييرها في تطبيق حقيقي)
let adminToken = null; // لتخزين توكن جلسة المشرف

// --- إعداد قاعدة البيانات SQLite ---
const db = new sqlite3.Database('./delivery_app.db', (err) => {
    if (err) {
        console.error("Error opening database", err.message);
    } else {
        console.log("Connected to the SQLite database.");
        // إنشاء الجداول إذا لم تكن موجودة
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone_number TEXT UNIQUE NOT NULL,
            name TEXT,
            role TEXT DEFAULT 'customer',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(`CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            pickup_lat REAL NOT NULL,
            pickup_lng REAL NOT NULL,
            dropoff_lat REAL NOT NULL,
            dropoff_lng REAL NOT NULL,
            status TEXT NOT NULL DEFAULT 'SEARCHING_DRIVER',
            price REAL,
            distance_km REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (customer_id) REFERENCES users (id)
        )`);
        // --- جدول جديد للمناديب ---
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
    }
});


// --- إعدادات Twilio ---
const accountSid = 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'; // حسابك في Twilio
const authToken = 'your_twilio_auth_token';       // توكن المصادقة من Twilio
const twilioClient = require('twilio')(accountSid, authToken);
const twilioPhoneNumber = '+15017122661'; // رقمك الذي اشتريته من Twilio

const otpStore = {}; 
const sessionStore = {}; // لتخزين جلسات المستخدمين { token: userId }

// --- نقطة API لطلب كود التحقق ---
app.post('/api/auth/request-otp', async (req, res) => {
    const { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ error: 'Phone number is required.' });

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
        console.error("Error sending SMS:", error);
        if (error.code === 20003) {
             console.log("Twilio auth failed, but simulating success for testing.");
             return res.status(200).json({ success: true, message: 'OTP sent successfully (Simulated).' });
        }
        res.status(500).json({ error: 'Failed to send OTP.' });
    }
});

// --- نقطة API للتحقق من الكود وإنشاء جلسة ---
app.post('/api/auth/verify-otp', (req, res) => {
    const { phoneNumber, otpCode } = req.body;
    if (!phoneNumber || !otpCode) return res.status(400).json({ error: 'Phone number and OTP are required.' });

    const storedOtp = otpStore[phoneNumber];
    if (storedOtp && storedOtp.code === otpCode && Date.now() < storedOtp.expires) {
        delete otpStore[phoneNumber];

        // البحث عن المستخدم أو إنشاؤه
        db.get('SELECT * FROM users WHERE phone_number = ?', [phoneNumber], (err, user) => {
            if (err) return res.status(500).json({ error: 'Database error.' });

            const handleUserLogin = (userId, userRole, isDriverVerified) => {
                const token = crypto.randomBytes(32).toString('hex');
                sessionStore[token] = userId;
                res.status(200).json({ 
                    success: true, 
                    message: 'Login successful!', 
                    token,
                    role: userRole,
                    isDriverVerified: isDriverVerified
                });
            };

            if (user) { // المستخدم موجود
                 // التحقق إذا كان سائقاً
                db.get('SELECT verified FROM drivers WHERE user_id = ?', [user.id], (err, driver) => {
                     handleUserLogin(user.id, user.role, driver ? !!driver.verified : null);
                });
            } else { // مستخدم جديد
                db.run('INSERT INTO users (phone_number) VALUES (?)', [phoneNumber], function(err) {
                    if (err) return res.status(500).json({ error: 'Failed to create user.' });
                    handleUserLogin(this.lastID, 'customer', null);
                });
            }
        });
    } else {
        res.status(400).json({ error: 'Invalid or expired OTP.' });
    }
});

// --- Middleware للتحقق من التوكن ---
const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (token && sessionStore[token]) {
        req.userId = sessionStore[token];
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized' });
    }
};

// --- نقطة API جديدة لتسجيل المندوب ---
app.post('/api/drivers/register', authenticate, (req, res) => {
    const userId = req.userId;
    const { name, vehicleType, licensePlate } = req.body;

    if (!name || !vehicleType || !licensePlate) {
        return res.status(400).json({ error: 'Name, vehicle type, and license plate are required.' });
    }

    db.get('SELECT * FROM drivers WHERE user_id = ?', [userId], (err, driver) => {
        if (err) return res.status(500).json({ error: 'Database error while checking driver.' });
        if (driver) return res.status(409).json({ error: 'This user is already registered as a driver.' });

        db.serialize(() => {
            db.run('BEGIN TRANSACTION;');
            
            db.run(`UPDATE users SET name = ?, role = 'driver' WHERE id = ?`, [name, userId]);
            
            const driverSql = `INSERT INTO drivers (user_id, vehicle_type, license_plate) VALUES (?, ?, ?)`;
            db.run(driverSql, [userId, vehicleType, licensePlate], function(err) {
                if (err) {
                    db.run('ROLLBACK;');
                    console.error("Driver registration error:", err);
                    return res.status(500).json({ error: 'Failed to register driver.' });
                }
                
                db.run('COMMIT;', (commitErr) => {
                     if (commitErr) {
                         console.error("Commit error:", commitErr);
                         return res.status(500).json({ error: 'Failed to commit driver registration.' });
                     }
                     res.status(201).json({ success: true, message: 'Driver registration submitted successfully. Waiting for approval.' });
                });
            });
        });
    });
});


// --- نقطة API جديدة للحصول على تسعيرة ---
app.post('/api/quote', authenticate, async (req, res) => {
    const { pickup, dropoff } = req.body;
    if (!pickup || !dropoff) return res.status(400).json({ error: 'Pickup and dropoff locations are required.'});

    try {
        const directionsResponse = await googleMapsClient.directions({
            params: {
                origin: pickup,
                destination: dropoff,
                key: GOOGLE_MAPS_API_KEY,
                mode: 'DRIVING',
            },
            timeout: 2000 // ثانيتان
        });

        if (directionsResponse.data.routes.length > 0) {
            const route = directionsResponse.data.routes[0].legs[0];
            const distanceKm = route.distance.value / 1000; // بالكيلومتر
            const durationMin = route.duration.value / 60; // بالدقائق

            // نفس منطق التسعير
            const baseFare = 20;
            const perKmRate = 4;
            const price = baseFare + (distanceKm * perKmRate);

            res.status(200).json({
                distanceKm: distanceKm.toFixed(2),
                durationMin: durationMin.toFixed(0),
                price: price.toFixed(2)
            });
        } else {
            res.status(404).json({ error: "Could not find a route." });
        }
    } catch (e) {
        console.error("Google Maps API error:", e);
        res.status(500).json({ error: "Failed to calculate quote." });
    }
});

// --- نقطة API لإنشاء طلب جديد (معدلة لاستخدام Google Maps) ---
app.post('/api/orders', authenticate, async (req, res) => { // Make async
    const { pickup, dropoff } = req.body;
    const customerId = req.userId;

    if (!pickup || !dropoff) return res.status(400).json({ error: 'Pickup and dropoff locations are required.'});
    
    // إعادة حساب السعر في الواجهة الخلفية لضمان الدقة والأمان
    try {
        const directionsResponse = await googleMapsClient.directions({
            params: {
                origin: pickup,
                destination: dropoff,
                key: GOOGLE_MAPS_API_KEY,
                mode: 'DRIVING',
            }
        });

        if (directionsResponse.data.routes.length > 0) {
            const route = directionsResponse.data.routes[0].legs[0];
            const distanceKm = route.distance.value / 1000;

            const baseFare = 20;
            const perKmRate = 4;
            const price = baseFare + (distanceKm * perKmRate);

            const sql = `INSERT INTO orders (customer_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, price, distance_km) VALUES (?, ?, ?, ?, ?, ?, ?)`;
            const params = [customerId, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng, price.toFixed(2), distanceKm.toFixed(2)];

            db.run(sql, params, function(err) {
                if (err) return res.status(500).json({ error: 'Failed to create order.' });
                
                res.status(201).json({
                    id: this.lastID,
                    customerId,
                    pickup,
                    dropoff,
                    price: price.toFixed(2),
                    distanceKm: distanceKm.toFixed(2),
                    status: 'SEARCHING_DRIVER'
                });
            });
        } else {
            return res.status(404).json({ error: "Could not find a route to create order." });
        }
    } catch (e) {
        console.error("Google Maps API error on order creation:", e);
        return res.status(500).json({ error: "Failed to create order due to maps service error." });
    }
});

// --- نقطة API جديدة لجلب سجل الطلبات ---
app.get('/api/orders/history', authenticate, (req, res) => {
    const customerId = req.userId;

    const sql = "SELECT id, status, price, created_at FROM orders WHERE customer_id = ? ORDER BY created_at DESC";

    db.all(sql, [customerId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: "Failed to retrieve order history." });
        }
        res.status(200).json(rows);
    });
});

// --- نقاط API خاصة بالمشرف (Admin) ---

// 1. تسجيل دخول المشرف
app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_SECRET_KEY) {
        adminToken = crypto.randomBytes(32).toString('hex');
        res.status(200).json({ success: true, token: adminToken });
    } else {
        res.status(401).json({ error: 'Invalid password' });
    }
});

// 2. Middleware للتحقق من المشرف
const authenticateAdmin = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (token && token === adminToken) {
        next();
    } else {
        res.status(401).json({ error: 'Unauthorized Admin' });
    }
};

// 3. جلب كل المناديب
app.get('/api/admin/drivers', authenticateAdmin, (req, res) => {
    const sql = `
        SELECT u.id, u.name, u.phone_number, d.vehicle_type, d.license_plate, d.verified
        FROM users u
        JOIN drivers d ON u.id = d.user_id
        ORDER BY d.verified ASC, u.created_at DESC
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            console.error(err);
            return res.status(500).json({ error: 'Failed to retrieve drivers.' });
        }
        res.status(200).json(rows);
    });
});

// 4. تفعيل حساب مندوب
app.post('/api/admin/drivers/:id/verify', authenticateAdmin, (req, res) => {
    const driverId = req.params.id;
    const { verified } = req.body; // Expects { verified: true }

    if (typeof verified !== 'boolean') {
        return res.status(400).json({ error: 'A boolean "verified" status is required.' });
    }

    const sql = `UPDATE drivers SET verified = ? WHERE user_id = ?`;
    db.run(sql, [verified, driverId], function(err) {
        if (err) {
            return res.status(500).json({ error: 'Failed to update driver status.' });
        }
        if (this.changes === 0) {
            return res.status(404).json({ error: 'Driver not found.' });
        }
        res.status(200).json({ success: true, message: 'Driver status updated.' });
    });
});


const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

