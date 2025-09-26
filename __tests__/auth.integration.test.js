process.env.NODE_ENV = 'test';
process.env.SQLITE_DB_PATH = ':memory:';
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.BASE_URL = 'http://localhost:3000';

const request = require('supertest');
const jwt = require('jsonwebtoken');

const { app, initDatabase, closeDatabase, CONFIG } = require('../server');

beforeAll(async () => {
  await initDatabase();
});

afterAll(async () => {
  await closeDatabase();
});

describe('Phone OTP authentication', () => {
  it('issues an OTP and verifies a customer session', async () => {
    const phoneNumber = '+201000000001';

    const requestResponse = await request(app)
      .post('/api/auth/otp/request')
      .send({ phone: phoneNumber })
      .expect(200);

    expect(requestResponse.body).toMatchObject({ success: true });
    expect(requestResponse.body.mock).toBe(true);
    expect(requestResponse.body.code).toHaveLength(4);

    const verifyResponse = await request(app)
      .post('/api/auth/otp/verify')
      .send({ phone: phoneNumber, code: requestResponse.body.code, role: 'customer' })
      .expect(200);

    expect(verifyResponse.body).toMatchObject({ success: true, role: 'customer' });
    const payload = jwt.verify(verifyResponse.body.token, CONFIG.jwtSecret);
    expect(payload).toHaveProperty('sub');
  });

  it('upgrades user role when verifying as a driver', async () => {
    const phoneNumber = '+201000000002';

    const requestResponse = await request(app)
      .post('/api/auth/otp/request')
      .send({ phone: phoneNumber })
      .expect(200);

    const verifyResponse = await request(app)
      .post('/api/auth/otp/verify')
      .send({ phone: phoneNumber, code: requestResponse.body.code, role: 'driver' })
      .expect(200);

    expect(verifyResponse.body.role).toBe('driver');
    const payload = jwt.verify(verifyResponse.body.token, CONFIG.jwtSecret);
    expect(payload).toMatchObject({ role: 'driver' });
  });

  it('enforces rate limiting after repeated OTP requests', async () => {
    const phoneNumber = '+201000000003';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app)
        .post('/api/auth/otp/request')
        .send({ phone: phoneNumber })
        .expect(200);
    }

    const throttled = await request(app)
      .post('/api/auth/otp/request')
      .send({ phone: phoneNumber })
      .expect(429);

    expect(throttled.body.message).toBeDefined();
  });
});
