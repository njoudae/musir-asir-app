const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'musir-test-'));
process.env.DATA_DIR = testDataDir;
process.env.SMS_PROVIDER = 'console';
process.env.OTP_DELIVERY_MODE = 'onscreen';
process.env.DEV_OTP_EXPOSE = 'true';
process.env.AI_PROVIDER = 'mock';
process.env.DATA_PROVIDER = 'json';
process.env.ADMIN_PIN = '2468';
process.env.APP_SECRET = 'test-secret-with-enough-entropy';

const { server, normalizePhone, normalizePlate, ticketStatus } = require('../lib/server');

let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function request(url, { token, body, method } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, data: await response.json() };
}

test('normalizes Saudi phone numbers and plates', () => {
  assert.equal(normalizePhone('050 123 4567'), '966501234567');
  assert.equal(normalizePhone('+966501234567'), '966501234567');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizePlate(' ا ب ج   1234 '), 'ا ب ج 1234');
});

test('computes ticket status from expiry', () => {
  assert.equal(ticketStatus({ status: 'active', expiresAt: new Date(Date.now() + 10000).toISOString() }), 'active');
  assert.equal(ticketStatus({ status: 'active', expiresAt: new Date(Date.now() - 10000).toISOString() }), 'expired');
  assert.equal(ticketStatus({ status: 'active', issuedAt: new Date(Date.now() - 61 * 60 * 1000).toISOString(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }), 'expired');
});

test('serves only the new public application files', async () => {
  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /مُسيّر/);
  const brandLogo = await fetch(`${baseUrl}/musir-logo.jpg`);
  assert.equal(brandLogo.status, 200);
  assert.match(brandLogo.headers.get('content-type'), /^image\/jpeg/);
  for (const demoImage of ['demo-identity.png', 'demo-vehicle-license.png', 'demo-company-permit.png']) {
    const response = await fetch(`${baseUrl}/${demoImage}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\/png/);
  }
  const legacy = await fetch(`${baseUrl}/configs.js`);
  assert.equal(legacy.status, 403);
  const privateStore = await fetch(`${baseUrl}/data/store.json`);
  assert.equal(privateStore.status, 403);
});

test('completes OTP, profile, document, ticket, tracking, and admin crossing flow', async () => {
  const otp = await request('/api/auth/request-otp', { body: { phone: '0501234567' } });
  assert.equal(otp.status, 200);
  assert.equal(otp.data.delivery.provider, 'onscreen');
  assert.match(otp.data.debugCode, /^\d{6}$/);

  const verification = await request('/api/auth/verify-otp', { body: { phone: '0501234567', code: otp.data.debugCode } });
  assert.equal(verification.status, 200);
  const token = verification.data.token;

  const profile = await request('/api/me/profile', { method: 'PUT', token, body: { fullName: 'سائق اختبار', nationalId: '1000000000', nationalIdExpiry: '2030-01-01' } });
  assert.equal(profile.data.user.profileComplete, true);

  const image = 'data:image/png;base64,iVBORw0KGgo=';
  for (const documentType of ['identity', 'vehicle_license', 'company_permit']) {
    const analysis = await request('/api/documents/analyze', { token, body: { documentType, dataUrl: image } });
    assert.equal(analysis.status, 200);
  }

  const ticket = await request('/api/tickets', { token, body: {
    crossingPointId: 'shaaar',
    fields: {
      truckPlateNumber: 'ا ب ج 1234', vehicleRegistrationNumber: 'VR-001', vehicleLicenseExpiry: '2030-01-01',
      companyName: 'شركة اختبار', crossingPermitNumber: 'CP-001', companyPermitExpiry: '2030-01-01', cargoType: 'حمولة عامة'
    }
  } });
  assert.equal(ticket.status, 201);
  assert.equal(ticket.data.ticket.status, 'active');
  const ticketLifetime = new Date(ticket.data.ticket.expiresAt).getTime() - new Date(ticket.data.ticket.issuedAt).getTime();
  assert.equal(ticketLifetime, 60 * 60 * 1000);

  const location = await request(`/api/tickets/${ticket.data.ticket.id}/locations`, { token, body: { lat: 18.24, lng: 42.51, accuracy: 10 } });
  assert.equal(location.status, 201);

  const stoppedTracking = await request(`/api/tickets/${ticket.data.ticket.id}/tracking`, { token, body: { active: false } });
  assert.equal(stoppedTracking.status, 200);
  const pausedDashboard = await request('/api/admin/dashboard', { token: (await request('/api/admin/login', { body: { pin: '2468' } })).data.token });
  assert.equal(pausedDashboard.data.stats.trackedTrucks, 0);

  const resumedLocation = await request(`/api/tickets/${ticket.data.ticket.id}/locations`, { token, body: { lat: 18.241, lng: 42.512, accuracy: 8 } });
  assert.equal(resumedLocation.status, 201);

  const adminLogin = await request('/api/admin/login', { body: { pin: '2468' } });
  const adminToken = adminLogin.data.token;
  const validCrossing = await request('/api/admin/crossing-events', { token: adminToken, body: { plate: 'ا ب ج 1234', crossingPointId: 'shaaar' } });
  assert.equal(validCrossing.data.violationRecorded, false);
  const invalidCrossing = await request('/api/admin/crossing-events', { token: adminToken, body: { plate: 'س ع د 9999', crossingPointId: 'shaaar' } });
  assert.equal(invalidCrossing.data.violationRecorded, true);

  const dashboard = await request('/api/admin/dashboard', { token: adminToken });
  assert.equal(dashboard.data.stats.activeTickets, 1);
  assert.equal(dashboard.data.stats.trackedTrucks, 1);
  assert.equal(dashboard.data.stats.violations, 1);
});
