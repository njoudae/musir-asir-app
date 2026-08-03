const fs = require('node:fs');
const path = require('node:path');
const { ConvexHttpClient } = require('convex/browser');
const { makeFunctionReference } = require('convex/server');

function loadLocalEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  const source = fs.readFileSync(envPath, 'utf8');
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

async function main() {
  loadLocalEnv();
  const url = process.env.CONVEX_URL;
  const serviceSecret = process.env.MUSIR_SERVICE_SECRET;
  if (!url || !serviceSecret) throw new Error('Convex configuration is missing');

  const client = new ConvexHttpClient(url);
  const args = (extra = {}) => ({ serviceSecret, ...extra });
  const fn = (name) => makeFunctionReference(`backend:${name}`);

  await client.mutation(fn('seedCrossingPoints'), args());
  const points = await client.query(fn('getCrossingPoints'), args());
  if (points.length !== 3) throw new Error(`Expected 3 crossing points, received ${points.length}`);

  const suffix = Date.now().toString().slice(-8);
  const now = new Date();
  const user = await client.mutation(fn('findOrCreateUser'), args({
    externalId: `usr-smoke-${suffix}`,
    phone: `9665${suffix}`,
    createdAt: now.toISOString(),
  }));
  await client.mutation(fn('updateProfile'), args({
    externalUserId: user.id,
    fullName: 'سائق اختبار الربط',
    nationalId: `10${suffix}`,
    nationalIdExpiry: '2030-12-31',
    profileComplete: true,
    updatedAt: now.toISOString(),
  }));

  const ticket = await client.mutation(fn('createTicket'), args({
    externalId: `tkt-smoke-${suffix}`,
    externalUserId: user.id,
    driver: {
      fullName: 'سائق اختبار الربط',
      nationalId: `10${suffix}`,
      nationalIdExpiry: '2030-12-31',
      phone: user.phone,
    },
    truckPlateNumber: `تجربة-${suffix.slice(-4)}`,
    vehicleRegistrationNumber: `REG-${suffix}`,
    vehicleLicenseExpiry: '2030-12-31',
    companyName: 'شركة اختبار التكامل',
    crossingPermitNumber: `PERMIT-${suffix}`,
    companyPermitExpiry: '2030-12-31',
    cargoType: 'حمولة اختبار',
    crossingPoint: points[0],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
  }));

  await client.mutation(fn('recordLocation'), args({
    externalUserId: user.id,
    ticketExternalId: ticket.id,
    lat: 18.2164,
    lng: 42.5053,
    accuracy: 8,
    recordedAt: new Date().toISOString(),
  }));

  const dashboard = await client.query(fn('adminDashboard'), args({ nowMs: Date.now() }));
  const vehicle = dashboard.vehicles.find((item) => item.id === ticket.id);
  if (!vehicle?.latestLocation) throw new Error('Live location did not reach the admin dashboard');
  if (vehicle.status !== 'active') throw new Error(`Expected an active ticket, received ${vehicle.status}`);

  console.log(`Convex smoke test passed: ${points.length} points, ticket ${ticket.ticketNumber}, live location visible in admin.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
