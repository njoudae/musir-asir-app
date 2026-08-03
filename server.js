const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ConvexHttpClient } = require('convex/browser');
const { makeFunctionReference } = require('convex/server');

loadEnv(path.join(__dirname, '.env.local'));
loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const APP_SECRET = process.env.APP_SECRET || 'musir-development-secret-change-me';
const ADMIN_PIN = process.env.ADMIN_PIN || '2468';
const BODY_LIMIT = 12 * 1024 * 1024;
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const DATA_PROVIDER = process.env.DATA_PROVIDER || 'json';
const CONVEX_SERVICE_SECRET = process.env.MUSIR_SERVICE_SECRET || '';
const convexClient = DATA_PROVIDER === 'convex' && process.env.CONVEX_URL ? new ConvexHttpClient(process.env.CONVEX_URL) : null;
const convexFunctions = {
  saveOtpChallenge: makeFunctionReference('backend:saveOtpChallenge'),
  verifyOtpChallenge: makeFunctionReference('backend:verifyOtpChallenge'),
  checkRateLimit: makeFunctionReference('backend:checkRateLimit'),
  seedCrossingPoints: makeFunctionReference('backend:seedCrossingPoints'),
  getCrossingPoints: makeFunctionReference('backend:getCrossingPoints'),
  findOrCreateUser: makeFunctionReference('backend:findOrCreateUser'),
  getAccount: makeFunctionReference('backend:getAccount'),
  updateProfile: makeFunctionReference('backend:updateProfile'),
  createTicket: makeFunctionReference('backend:createTicket'),
  recordLocation: makeFunctionReference('backend:recordLocation'),
  adminDashboard: makeFunctionReference('backend:adminDashboard'),
  recordCrossing: makeFunctionReference('backend:recordCrossing')
};
const OTP_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_FILES = new Set([
  'index.html', 'styles.css', 'script.js', 'i18n.js', 'manifest.json', 'logo.svg',
  'musir-logo.jpg',
  'admin.html', 'admin.css', 'admin.js'
]);

const DEFAULT_POINTS = [
  { id: 'shaaar', name: 'عقبة شعار', route: 'أبها / خميس مشيط إلى محايل', lat: 18.3326, lng: 42.2769 },
  { id: 'aslan', name: 'عقبة عسلان', route: 'أبها إلى خميس البحر', lat: 18.3909, lng: 42.0572 },
  { id: 'dalaa', name: 'عقبة ضلع', route: 'أبها إلى جازان', lat: 18.1407, lng: 42.3979 }
];

const otpChallenges = new Map();
const rateLimits = new Map();

if (process.env.NODE_ENV === 'production' && APP_SECRET === 'musir-development-secret-change-me') {
  throw new Error('APP_SECRET must be configured in production');
}

if (DATA_PROVIDER === 'json') ensureStore();

if (DATA_PROVIDER === 'convex' && (!convexClient || CONVEX_SERVICE_SECRET.length < 32)) {
  throw new Error('Convex configuration is incomplete');
}

function convexArgs(args = {}) {
  return { serviceSecret: CONVEX_SERVICE_SECRET, ...args };
}

async function convexQuery(reference, args = {}) {
  if (!convexClient) throw new Error('Convex is not configured');
  return convexClient.query(reference, convexArgs(args));
}

async function convexMutation(reference, args = {}) {
  if (!convexClient) throw new Error('Convex is not configured');
  return convexClient.mutation(reference, convexArgs(args));
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function initialStore() {
  return {
    users: [],
    tickets: [],
    locations: [],
    violations: [],
    crossingEvents: [],
    crossingPoints: DEFAULT_POINTS
  };
}

function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) writeStore(initialStore());
}

function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    data.crossingPoints ||= DEFAULT_POINTS;
    data.crossingEvents ||= [];
    return data;
  } catch (error) {
    console.error('تعذر قراءة قاعدة البيانات:', error);
    return initialStore();
  }
}

function writeStore(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temporary, STORE_FILE);
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin'
  });
  res.end(JSON.stringify(body));
}

function apiError(res, status, message, details) {
  json(res, status, { ok: false, message, ...(details ? { details } : {}) });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('حجم الطلب أكبر من الحد المسموح'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('صيغة JSON غير صحيحة'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function normalizePhone(value = '') {
  let phone = String(value).replace(/\D/g, '');
  if (phone.startsWith('00966')) phone = phone.slice(2);
  if (phone.startsWith('05')) phone = `966${phone.slice(1)}`;
  if (phone.startsWith('5')) phone = `966${phone}`;
  return /^9665\d{8}$/.test(phone) ? phone : null;
}

function normalizePlate(value = '') {
  return String(value).trim().replace(/\s+/g, ' ').toUpperCase();
}

function hash(value) {
  return crypto.createHmac('sha256', APP_SECRET).update(String(value)).digest('hex');
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function createToken(subject, role = 'driver') {
  const payload = base64url(JSON.stringify({ sub: subject, role, exp: Date.now() + TOKEN_TTL_MS }));
  return `${payload}.${base64url(crypto.createHmac('sha256', APP_SECRET).update(payload).digest())}`;
}

function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = base64url(crypto.createHmac('sha256', APP_SECRET).update(payload).digest());
  if (!safeEqual(signature, expected)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded.exp > Date.now() ? decoded : null;
  } catch {
    return null;
  }
}

function auth(req, role = 'driver') {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const session = verifyToken(token);
  if (!session || (role && session.role !== role)) return null;
  return session;
}

async function rateLimited(key, limit, windowMs) {
  if (DATA_PROVIDER === 'convex') {
    return convexMutation(convexFunctions.checkRateLimit, { key, limit, windowMs, nowMs: Date.now() });
  }
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || current.resetAt < now) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  current.count += 1;
  return current.count > limit;
}

async function sendOtp(phone, code) {
  const provider = process.env.SMS_PROVIDER || 'console';
  if (provider === 'console') {
    console.log(`[MUSIR OTP] ${phone}: ${code}`);
    return { provider: 'console', accepted: true };
  }
  if (provider !== 'unifonic') throw new Error('مزود SMS غير مدعوم');
  if (!process.env.UNIFONIC_APP_SID || !process.env.UNIFONIC_SENDER_ID) {
    throw new Error('بيانات Unifonic غير مكتملة');
  }
  const form = new URLSearchParams({
    AppSid: process.env.UNIFONIC_APP_SID,
    SenderID: process.env.UNIFONIC_SENDER_ID,
    Body: `رمز التحقق في مسير: ${code}. صالح لمدة 5 دقائق. لا تشاركه مع أحد.`,
    Recipient: phone,
    responseType: 'JSON',
    CorrelationID: randomId('otp'),
    baseEncode: 'true',
    async: 'false'
  });
  const response = await fetch('https://el.cloud.unifonic.com/rest/SMS/messages', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false || result.success === 'false') {
    throw new Error(result.message || 'تعذر إرسال رسالة التحقق');
  }
  return { provider: 'unifonic', accepted: true, messageId: result.data?.MessageID };
}

const EXTRACTION_SCHEMAS = {
  identity: {
    label: 'الهوية أو الإقامة',
    fields: ['fullName', 'nationalId', 'nationalIdExpiry'],
    properties: {
      fullName: 'الاسم الكامل كما يظهر في الوثيقة',
      nationalId: 'رقم الهوية الوطنية أو الإقامة',
      nationalIdExpiry: 'تاريخ انتهاء الهوية بصيغة YYYY-MM-DD'
    }
  },
  vehicle_license: {
    label: 'رخصة أو استمارة المركبة',
    fields: ['vehicleRegistrationNumber', 'truckPlateNumber', 'vehicleLicenseExpiry'],
    properties: {
      vehicleRegistrationNumber: 'رقم رخصة السير أو الاستمارة',
      truckPlateNumber: 'رقم لوحة الشاحنة بالحروف والأرقام',
      vehicleLicenseExpiry: 'تاريخ انتهاء رخصة السير بصيغة YYYY-MM-DD'
    }
  },
  company_permit: {
    label: 'ترخيص الشركة',
    fields: ['companyName', 'crossingPermitNumber', 'companyPermitExpiry', 'cargoType'],
    properties: {
      companyName: 'اسم الشركة أو المنشأة',
      crossingPermitNumber: 'رقم الترخيص أو تصريح العبور',
      companyPermitExpiry: 'تاريخ انتهاء الترخيص بصيغة YYYY-MM-DD',
      cargoType: 'نوع الحمولة المذكور في المستند'
    }
  }
};

function validateDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return false;
  return /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\r\n]+$/.test(dataUrl) && dataUrl.length < 11_000_000;
}

function mockExtraction(type) {
  if (type === 'identity') return { fullName: 'سائق تجريبي', nationalId: '1000000000', nationalIdExpiry: '2030-12-31' };
  if (type === 'vehicle_license') return { vehicleRegistrationNumber: 'VR-2026-001', truckPlateNumber: 'ا ب ج 1234', vehicleLicenseExpiry: '2030-12-31' };
  return { companyName: 'شركة مسير للنقل', crossingPermitNumber: 'CP-2026-001', companyPermitExpiry: '2030-12-31', cargoType: 'حمولة عامة' };
}

async function extractDocument(type, dataUrl, userId) {
  const schema = EXTRACTION_SCHEMAS[type];
  if (!schema) throw Object.assign(new Error('نوع المستند غير مدعوم'), { status: 400 });
  if ((process.env.AI_PROVIDER || 'mock') === 'mock') return mockExtraction(type);
  if (!process.env.OPENAI_API_KEY) throw new Error('مفتاح OpenAI غير مضبوط في الخادم');

  const jsonProperties = Object.fromEntries(schema.fields.map((field) => [field, { type: ['string', 'null'], description: schema.properties[field] }]));
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-terra',
      store: false,
      safety_identifier: hash(userId).slice(0, 32),
      reasoning: { effort: 'low' },
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: `حلل صورة ${schema.label}. استخرج فقط القيم الظاهرة بوضوح. لا تخمّن. حوّل التواريخ إلى YYYY-MM-DD، وأعد null لأي قيمة غير موجودة.` },
          { type: 'input_image', image_url: dataUrl, detail: 'high' }
        ]
      }],
      text: {
        format: {
          type: 'json_schema',
          name: `${type}_extraction`,
          strict: true,
          schema: { type: 'object', additionalProperties: false, properties: jsonProperties, required: schema.fields }
        }
      }
    })
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message || 'فشل تحليل المستند');
  const outputText = result.output_text || result.output?.flatMap((item) => item.content || []).find((item) => item.type === 'output_text')?.text;
  if (!outputText) throw new Error('لم يرجع المحلل بيانات قابلة للقراءة');
  return JSON.parse(outputText);
}

function sanitizeProfile(input, existing = {}) {
  return {
    ...existing,
    fullName: String(input.fullName || existing.fullName || '').trim().slice(0, 120),
    nationalId: String(input.nationalId || existing.nationalId || '').replace(/\D/g, '').slice(0, 10),
    nationalIdExpiry: String(input.nationalIdExpiry || existing.nationalIdExpiry || '').slice(0, 10),
    nafathVerified: Boolean(existing.nafathVerified),
    profileComplete: Boolean(String(input.fullName || existing.fullName || '').trim() && /^\d{10}$/.test(String(input.nationalId || existing.nationalId || '')) && /^\d{4}-\d{2}-\d{2}$/.test(String(input.nationalIdExpiry || existing.nationalIdExpiry || '')))
  };
}

function publicUser(user) {
  return {
    id: user.id,
    phone: user.phone,
    fullName: user.fullName || '',
    nationalId: user.nationalId || '',
    nationalIdExpiry: user.nationalIdExpiry || '',
    nafathVerified: Boolean(user.nafathVerified),
    profileComplete: Boolean(user.profileComplete)
  };
}

function ticketStatus(ticket, now = Date.now()) {
  if (ticket.status === 'cancelled') return 'cancelled';
  return new Date(ticket.expiresAt).getTime() > now ? 'active' : 'expired';
}

function publicTicket(ticket) {
  return { ...ticket, status: ticketStatus(ticket) };
}

async function handleApi(req, res, url) {
  const method = req.method;
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'musir', time: new Date().toISOString() });
  }

  if (method === 'POST' && pathname === '/api/auth/request-otp') {
    const body = await parseBody(req);
    const phone = normalizePhone(body.phone);
    if (!phone) return apiError(res, 400, 'أدخل رقم جوال سعودي صحيح');
    const ip = req.socket.remoteAddress || 'unknown';
    if (await rateLimited(`otp:${phone}`, 3, 15 * 60 * 1000) || await rateLimited(`ip:${ip}`, 10, 15 * 60 * 1000)) {
      return apiError(res, 429, 'تم تجاوز عدد المحاولات. حاول لاحقًا');
    }
    const code = String(crypto.randomInt(100000, 1000000));
    const codeHash = hash(`${phone}:${code}`);
    const expiresAt = Date.now() + OTP_TTL_MS;
    if (DATA_PROVIDER === 'convex') await convexMutation(convexFunctions.saveOtpChallenge, { phone, codeHash, expiresAt });
    else otpChallenges.set(phone, { codeHash, expiresAt, attempts: 0 });
    try {
      const delivery = await sendOtp(phone, code);
      const expose = process.env.NODE_ENV !== 'production' && process.env.DEV_OTP_EXPOSE !== 'false' && (process.env.SMS_PROVIDER || 'console') === 'console';
      return json(res, 200, { ok: true, phone, expiresIn: 300, delivery, ...(expose ? { debugCode: code } : {}) });
    } catch (error) {
      if (DATA_PROVIDER !== 'convex') otpChallenges.delete(phone);
      return apiError(res, 502, error.message);
    }
  }

  if (method === 'POST' && pathname === '/api/auth/verify-otp') {
    const body = await parseBody(req);
    const phone = normalizePhone(body.phone);
    if (!phone) return apiError(res, 400, 'انتهت صلاحية الرمز. اطلب رمزًا جديدًا');
    if (DATA_PROVIDER === 'convex') {
      const result = await convexMutation(convexFunctions.verifyOtpChallenge, { phone, codeHash: hash(`${phone}:${body.code || ''}`), nowMs: Date.now() });
      if (result === 'locked') return apiError(res, 429, 'تم تجاوز محاولات التحقق');
      if (result === 'invalid') return apiError(res, 401, 'رمز التحقق غير صحيح');
      if (result !== 'ok') return apiError(res, 400, 'انتهت صلاحية الرمز. اطلب رمزًا جديدًا');
    } else {
      const challenge = otpChallenges.get(phone);
      if (!challenge || challenge.expiresAt < Date.now()) return apiError(res, 400, 'انتهت صلاحية الرمز. اطلب رمزًا جديدًا');
      challenge.attempts += 1;
      if (challenge.attempts > 5) {
        otpChallenges.delete(phone);
        return apiError(res, 429, 'تم تجاوز محاولات التحقق');
      }
      if (!safeEqual(hash(`${phone}:${body.code || ''}`), challenge.codeHash)) return apiError(res, 401, 'رمز التحقق غير صحيح');
      otpChallenges.delete(phone);
    }
    let user;
    if (DATA_PROVIDER === 'convex') {
      user = await convexMutation(convexFunctions.findOrCreateUser, { externalId: randomId('usr'), phone, createdAt: new Date().toISOString() });
    } else {
      const store = readStore();
      user = store.users.find((item) => item.phone === phone);
      if (!user) {
        user = { id: randomId('usr'), phone, createdAt: new Date().toISOString(), profileComplete: false, nafathVerified: false };
        store.users.push(user);
        writeStore(store);
      }
    }
    return json(res, 200, { ok: true, token: createToken(user.id), user: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/auth/nafath') {
    return apiError(res, 501, 'تكامل نفاذ جاهز للربط عند إصدار الترخيص وبيانات المزود', { code: 'NAFATH_NOT_CONFIGURED' });
  }

  if (method === 'POST' && pathname === '/api/admin/login') {
    const body = await parseBody(req);
    if (await rateLimited(`admin:${req.socket.remoteAddress}`, 8, 15 * 60 * 1000)) return apiError(res, 429, 'محاولات كثيرة');
    if (!safeEqual(body.pin || '', ADMIN_PIN)) return apiError(res, 401, 'رمز الإدارة غير صحيح');
    return json(res, 200, { ok: true, token: createToken('admin', 'admin') });
  }

  if (method === 'GET' && pathname === '/api/crossing-points') {
    const points = DATA_PROVIDER === 'convex'
      ? await convexQuery(convexFunctions.getCrossingPoints)
      : readStore().crossingPoints;
    return json(res, 200, { ok: true, points });
  }

  if (pathname.startsWith('/api/admin/')) return handleAdminApi(req, res, url);

  const session = auth(req);
  if (!session) return apiError(res, 401, 'يجب تسجيل الدخول');
  const store = DATA_PROVIDER === 'json' ? readStore() : null;
  const account = DATA_PROVIDER === 'convex'
    ? await convexQuery(convexFunctions.getAccount, { externalUserId: session.sub, nowMs: Date.now() })
    : null;
  const user = DATA_PROVIDER === 'convex' ? account?.user : store.users.find((item) => item.id === session.sub);
  if (!user) return apiError(res, 401, 'الحساب غير موجود');

  if (method === 'GET' && pathname === '/api/me') {
    const tickets = DATA_PROVIDER === 'convex'
      ? account.tickets
      : store.tickets.filter((ticket) => ticket.userId === user.id).map(publicTicket).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    return json(res, 200, { ok: true, user: publicUser(user), tickets });
  }

  if (method === 'PUT' && pathname === '/api/me/profile') {
    const body = await parseBody(req);
    const sanitized = sanitizeProfile(body, user);
    if (DATA_PROVIDER === 'convex') {
      const updated = await convexMutation(convexFunctions.updateProfile, {
        externalUserId: user.id,
        fullName: sanitized.fullName,
        nationalId: sanitized.nationalId,
        nationalIdExpiry: sanitized.nationalIdExpiry,
        profileComplete: sanitized.profileComplete,
        updatedAt: new Date().toISOString()
      });
      return json(res, 200, { ok: true, user: updated });
    }
    Object.assign(user, sanitized, { updatedAt: new Date().toISOString() });
    writeStore(store);
    return json(res, 200, { ok: true, user: publicUser(user) });
  }

  if (method === 'POST' && pathname === '/api/documents/analyze') {
    const body = await parseBody(req);
    if (!EXTRACTION_SCHEMAS[body.documentType]) return apiError(res, 400, 'نوع المستند غير صحيح');
    if (!validateDataUrl(body.dataUrl)) return apiError(res, 400, 'ارفع صورة JPG أو PNG أو WEBP بحجم مناسب');
    try {
      const fields = await extractDocument(body.documentType, body.dataUrl, user.id);
      return json(res, 200, { ok: true, documentType: body.documentType, fields, source: process.env.AI_PROVIDER || 'mock' });
    } catch (error) {
      return apiError(res, error.status || 502, error.message);
    }
  }

  if (method === 'POST' && pathname === '/api/tickets') {
    const body = await parseBody(req);
    const crossingPoints = DATA_PROVIDER === 'convex'
      ? await convexQuery(convexFunctions.getCrossingPoints)
      : store.crossingPoints;
    const point = body.crossingPointId === 'custom'
      ? { id: 'custom', name: String(body.customPointName || '').trim().slice(0, 100), route: 'نقطة مضافة يدويًا', lat: Number(body.customLat), lng: Number(body.customLng) }
      : crossingPoints.find((item) => item.id === body.crossingPointId);
    if (!point || !point.name) return apiError(res, 400, 'اختر نقطة عبور صحيحة');
    if (body.crossingPointId === 'custom' && (!Number.isFinite(point.lat) || !Number.isFinite(point.lng) || Math.abs(point.lat) > 90 || Math.abs(point.lng) > 180)) {
      return apiError(res, 400, 'حدد موقع نقطة العبور المخصصة');
    }

    const fields = body.fields || {};
    const required = ['truckPlateNumber', 'vehicleRegistrationNumber', 'vehicleLicenseExpiry', 'companyName', 'crossingPermitNumber', 'companyPermitExpiry', 'cargoType'];
    const missing = required.filter((key) => !String(fields[key] || '').trim());
    if (!user.profileComplete) missing.unshift('profile');
    if (missing.length) return apiError(res, 422, 'بعض البيانات المطلوبة ناقصة', { missing });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiredFields = ['vehicleLicenseExpiry', 'companyPermitExpiry'].filter((key) => {
      const value = new Date(`${fields[key]}T00:00:00`);
      return Number.isNaN(value.getTime()) || value < today;
    });
    if (expiredFields.length) return apiError(res, 422, 'لا يمكن إصدار التذكرة بوثيقة منتهية أو بتاريخ غير صحيح', { expiredFields });

    const now = new Date();
    const validity = Number(process.env.TICKET_VALIDITY_HOURS || 24);
    const ticketInput = {
      id: randomId('tkt'),
      userId: user.id,
      driver: { fullName: user.fullName, nationalId: user.nationalId, nationalIdExpiry: user.nationalIdExpiry, phone: user.phone },
      truckPlateNumber: normalizePlate(fields.truckPlateNumber),
      vehicleRegistrationNumber: String(fields.vehicleRegistrationNumber).trim(),
      vehicleLicenseExpiry: String(fields.vehicleLicenseExpiry).slice(0, 10),
      companyName: String(fields.companyName).trim(),
      crossingPermitNumber: String(fields.crossingPermitNumber).trim(),
      companyPermitExpiry: String(fields.companyPermitExpiry).slice(0, 10),
      cargoType: String(fields.cargoType).trim(),
      crossingPoint: point,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + validity * 60 * 60 * 1000).toISOString(),
      status: 'active',
      trackingActive: true
    };
    if (DATA_PROVIDER === 'convex') {
      const ticket = await convexMutation(convexFunctions.createTicket, {
        externalId: ticketInput.id,
        externalUserId: user.id,
        driver: ticketInput.driver,
        truckPlateNumber: ticketInput.truckPlateNumber,
        vehicleRegistrationNumber: ticketInput.vehicleRegistrationNumber,
        vehicleLicenseExpiry: ticketInput.vehicleLicenseExpiry,
        companyName: ticketInput.companyName,
        crossingPermitNumber: ticketInput.crossingPermitNumber,
        companyPermitExpiry: ticketInput.companyPermitExpiry,
        cargoType: ticketInput.cargoType,
        crossingPoint: ticketInput.crossingPoint,
        issuedAt: ticketInput.issuedAt,
        expiresAt: ticketInput.expiresAt
      });
      return json(res, 201, { ok: true, ticket });
    }
    const ticket = { ...ticketInput, ticketNumber: `MSR-${now.getFullYear()}-${String(store.tickets.length + 1).padStart(6, '0')}` };
    store.tickets.push(ticket);
    writeStore(store);
    return json(res, 201, { ok: true, ticket: publicTicket(ticket) });
  }

  const locationMatch = pathname.match(/^\/api\/tickets\/([^/]+)\/locations$/);
  if (method === 'POST' && locationMatch) {
    const body = await parseBody(req);
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    const accuracy = Number(body.accuracy || 0);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return apiError(res, 400, 'إحداثيات غير صحيحة');
    if (DATA_PROVIDER === 'convex') {
      try {
        await convexMutation(convexFunctions.recordLocation, { externalUserId: user.id, ticketExternalId: locationMatch[1], lat, lng, accuracy, recordedAt: new Date().toISOString() });
        return json(res, 201, { ok: true });
      } catch (error) {
        if (error.message.includes('Ticket not found')) return apiError(res, 404, 'التذكرة غير موجودة');
        throw error;
      }
    }
    const ticket = store.tickets.find((item) => item.id === locationMatch[1] && item.userId === user.id);
    if (!ticket) return apiError(res, 404, 'التذكرة غير موجودة');
    store.locations.push({ id: randomId('loc'), ticketId: ticket.id, plate: ticket.truckPlateNumber, lat, lng, accuracy, recordedAt: new Date().toISOString() });
    if (store.locations.length > 10000) store.locations = store.locations.slice(-10000);
    writeStore(store);
    return json(res, 201, { ok: true });
  }

  return apiError(res, 404, 'المسار غير موجود');
}

async function handleAdminApi(req, res, url) {
  const session = auth(req, 'admin');
  if (!session) return apiError(res, 401, 'صلاحية الإدارة مطلوبة');
  const pathname = url.pathname;

  if (DATA_PROVIDER === 'convex') {
    if (req.method === 'GET' && pathname === '/api/admin/dashboard') {
      const dashboard = await convexQuery(convexFunctions.adminDashboard, { nowMs: Date.now() });
      return json(res, 200, { ok: true, ...dashboard });
    }
    if (req.method === 'POST' && pathname === '/api/admin/crossing-events') {
      const body = await parseBody(req);
      const plate = normalizePlate(body.plate);
      if (!plate) return apiError(res, 400, 'رقم اللوحة مطلوب');
      try {
        const result = await convexMutation(convexFunctions.recordCrossing, {
          externalId: randomId('evt'),
          violationExternalId: randomId('vio'),
          plate,
          crossingPointExternalId: String(body.crossingPointId || ''),
          createdAt: new Date().toISOString(),
          nowMs: Date.now()
        });
        return json(res, 201, { ok: true, ...result });
      } catch (error) {
        if (error.message.includes('Crossing point not found')) return apiError(res, 400, 'اختر نقطة عبور صحيحة');
        throw error;
      }
    }
    return apiError(res, 404, 'مسار الإدارة غير موجود');
  }

  const store = readStore();

  if (req.method === 'GET' && pathname === '/api/admin/dashboard') {
    const tickets = store.tickets.map(publicTicket).sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    const latestByTicket = new Map();
    for (const location of store.locations) {
      const current = latestByTicket.get(location.ticketId);
      if (!current || current.recordedAt < location.recordedAt) latestByTicket.set(location.ticketId, location);
    }
    const vehicles = tickets.map((ticket) => ({ ...ticket, latestLocation: latestByTicket.get(ticket.id) || null }));
    return json(res, 200, {
      ok: true,
      stats: {
        totalTickets: tickets.length,
        activeTickets: tickets.filter((ticket) => ticket.status === 'active').length,
        trackedTrucks: vehicles.filter((item) => item.status === 'active' && item.latestLocation).length,
        violations: store.violations.length
      },
      vehicles,
      violations: [...store.violations].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      crossingEvents: [...store.crossingEvents].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100),
      points: store.crossingPoints
    });
  }

  if (req.method === 'POST' && pathname === '/api/admin/crossing-events') {
    const body = await parseBody(req);
    const plate = normalizePlate(body.plate);
    const point = store.crossingPoints.find((item) => item.id === body.crossingPointId) || { id: 'custom', name: String(body.pointName || 'نقطة غير مسجلة') };
    if (!plate) return apiError(res, 400, 'رقم اللوحة مطلوب');
    const plateTickets = store.tickets
      .filter((ticket) => normalizePlate(ticket.truckPlateNumber) === plate && ticket.crossingPoint.id === point.id)
      .sort((a, b) => b.issuedAt.localeCompare(a.issuedAt));
    const current = plateTickets[0];
    const status = current ? ticketStatus(current) : 'none';
    const event = { id: randomId('evt'), plate, crossingPoint: point, ticketId: current?.id || null, ticketNumber: current?.ticketNumber || null, ticketStatus: status, createdAt: new Date().toISOString() };
    store.crossingEvents.push(event);
    if (status !== 'active') {
      store.violations.push({ id: randomId('vio'), plate, crossingPoint: point, ticketStatus: status, ticketNumber: current?.ticketNumber || null, createdAt: event.createdAt, reason: status === 'expired' ? 'عبور بتذكرة منتهية' : 'عبور دون تذكرة' });
    }
    writeStore(store);
    return json(res, 201, { ok: true, event, violationRecorded: status !== 'active' });
  }

  return apiError(res, 404, 'مسار الإدارة غير موجود');
}

function serveStatic(req, res, url) {
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const relative = pathname.replace(/^\/+/, '');
  const filePath = path.resolve(__dirname, relative);
  const publicRoot = `${path.resolve(__dirname)}${path.sep}`;
  if (!PUBLIC_FILES.has(relative.replace(/\\/g, '/')) || !filePath.startsWith(publicRoot) || filePath.includes(`${path.sep}data${path.sep}`) || path.basename(filePath).startsWith('.env')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    const mime = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg'
    }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': mime.includes('html') ? 'no-cache' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function requestHandler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else apiError(res, 405, 'الطريقة غير مسموحة');
  } catch (error) {
    console.error(error);
    if (!res.headersSent) apiError(res, error.status || 500, error.status ? error.message : 'حدث خطأ داخلي');
  }
}

const server = http.createServer(requestHandler);

if (require.main === module) {
  server.listen(PORT, () => console.log(`مسير يعمل على http://localhost:${PORT}`));
}

module.exports = { server, requestHandler, normalizePhone, normalizePlate, createToken, verifyToken, ticketStatus, readStore, writeStore, initialStore };
