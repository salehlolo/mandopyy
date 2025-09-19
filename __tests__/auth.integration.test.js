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

describe('Email + password authentication', () => {
  it('registers a user and allows them to log in with the issued JWT', async () => {
    const email = 'integration@example.com';
    const password = 'secret123';

    const registerResponse = await request(app)
      .post('/v1/auth/register')
      .send({ email, password, name: 'Integration Tester' })
      .expect(201);

    expect(registerResponse.body).toHaveProperty('token');
    expect(registerResponse.body).toHaveProperty('user');
    expect(registerResponse.body.user.email).toBe(email);

    const registerPayload = jwt.verify(registerResponse.body.token, CONFIG.jwtSecret);
    expect(registerPayload).toHaveProperty('sub');

    const loginResponse = await request(app)
      .post('/v1/auth/login')
      .send({ email, password })
      .expect(200);

    expect(loginResponse.body).toHaveProperty('token');
    const loginPayload = jwt.verify(loginResponse.body.token, CONFIG.jwtSecret);
    expect(loginPayload.sub).toBe(registerPayload.sub);
  });
});

describe('OAuth callback redirects when providers are disabled', () => {
  const baseUrl = 'http://localhost:3000';
  const driverUrl = `${baseUrl}/driver_app.html`;

  it('redirects Google callback to the default landing page with an error flag', async () => {
    const response = await request(app)
      .get('/v1/auth/google/callback')
      .redirects(0)
      .expect(302);

    expect(response.headers.location).toBe(`${baseUrl}#login_error`);
  });

  it('redirects Google callback with state=driver to the driver app', async () => {
    const response = await request(app)
      .get('/v1/auth/google/callback')
      .query({ state: 'driver' })
      .redirects(0)
      .expect(302);

    expect(response.headers.location).toBe(`${driverUrl}#login_error`);
  });

  it('redirects Facebook callback to the default landing page with an error flag', async () => {
    const response = await request(app)
      .get('/v1/auth/facebook/callback')
      .redirects(0)
      .expect(302);

    expect(response.headers.location).toBe(`${baseUrl}#login_error`);
  });

  it('redirects Facebook callback with state=driver to the driver app', async () => {
    const response = await request(app)
      .get('/v1/auth/facebook/callback')
      .query({ state: 'driver' })
      .redirects(0)
      .expect(302);

    expect(response.headers.location).toBe(`${driverUrl}#login_error`);
  });
});
