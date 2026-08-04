const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const t = (text) => window.MusirI18n?.t(text) || text;

const FIELD_CONFIG = {
  fullName: { label: 'الاسم الكامل', source: 'account', readonly: true },
  nationalId: { label: 'رقم الهوية أو الإقامة', source: 'account', readonly: true },
  nationalIdExpiry: { label: 'تاريخ انتهاء الهوية', source: 'account', type: 'date', readonly: true },
  vehicleRegistrationNumber: { label: 'رقم رخصة السير', source: 'document', document: 'vehicle_license' },
  truckPlateNumber: { label: 'رقم لوحة الشاحنة', source: 'document', document: 'vehicle_license' },
  vehicleLicenseExpiry: { label: 'انتهاء رخصة السير', source: 'document', document: 'vehicle_license', type: 'date' },
  companyName: { label: 'اسم الشركة', source: 'document', document: 'company_permit' },
  crossingPermitNumber: { label: 'رقم تصريح العبور', source: 'document', document: 'company_permit' },
  companyPermitExpiry: { label: 'انتهاء تصريح الشركة', source: 'document', document: 'company_permit', type: 'date' },
  cargoType: { label: 'نوع الحمولة', source: 'document', document: 'company_permit' }
};

const REQUIRED_BY_DOCUMENT = {
  identity: [],
  vehicle_license: ['vehicleRegistrationNumber', 'truckPlateNumber', 'vehicleLicenseExpiry'],
  company_permit: ['companyName', 'crossingPermitNumber', 'companyPermitExpiry', 'cargoType']
};

const state = {
  token: localStorage.getItem('musir-token') || '',
  phone: '',
  user: null,
  tickets: [],
  points: [],
  documentResults: {},
  files: {},
  ticketDraft: {},
  currentTicket: null,
  customLocation: null,
  map: null,
  marker: null,
  routeLine: null,
  watchId: null,
  lastLocationSentAt: 0,
  navigation: []
};

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
  bindEvents();
  setToday();
  try {
    const result = await api('/api/crossing-points', { auth: false });
    state.points = result.points;
  } catch (error) {
    console.warn(error);
  }

  if (state.token) {
    try {
      await loadAccount();
      showScreen(state.user.profileComplete ? 'dashboard' : 'profile', false);
    } catch {
      clearSession();
      showScreen('auth', false);
    }
  } else {
    showScreen('auth', false);
  }
}

function bindEvents() {
  $('#phone-form').addEventListener('submit', requestOtp);
  $('#otp-form').addEventListener('submit', verifyOtp);
  $('#resend-otp').addEventListener('click', () => requestOtp(null, state.phone));
  $('#nafath-button').addEventListener('click', startNafath);
  $('#profile-form').addEventListener('submit', saveProfile);
  $('#new-ticket-button').addEventListener('click', startNewTicket);
  $('#documents-continue').addEventListener('click', continueFromDocuments);
  $('#route-form').addEventListener('submit', issueTicket);
  $('#use-current-location').addEventListener('click', getCustomLocation);
  $('#open-tracking').addEventListener('click', () => openTracking(state.currentTicket));
  $('#success-home').addEventListener('click', async () => { await loadAccount(); showScreen('dashboard'); });
  $('#stop-tracking').addEventListener('click', stopTracking);
  $('#logout-button').addEventListener('click', logout);
  $('#back-button').addEventListener('click', navigateBack);

  $$('.upload-card input[type="file"]').forEach((input) => {
    input.addEventListener('change', () => handleDocumentFile(input.closest('.upload-card'), input.files[0]));
  });

  document.addEventListener('change', (event) => {
    if (event.target.name === 'crossing-point') {
      $('#custom-point-fields').classList.toggle('hidden', event.target.value !== 'custom');
    }
  });

  $('#ticket-list').addEventListener('click', (event) => {
    const item = event.target.closest('[data-ticket-id]');
    if (!item) return;
    const ticket = state.tickets.find((entry) => entry.id === item.dataset.ticketId);
    if (ticket?.status === 'active') openTracking(ticket);
  });

  window.addEventListener('hashchange', () => {
    const requested = location.hash.replace('#', '');
    if (requested && $(`[data-screen="${requested}"]`)) showScreen(requested, false);
  });

  window.addEventListener('musir:language', () => {
    setToday();
    if (state.user) renderDashboard();
    if (state.points.length) renderRoutes();
    if (Object.keys(state.documentResults).length) renderExtractedFields();
  });
}

async function api(endpoint, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  if (options.auth !== false && state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(endpoint, {
    method: options.method || (options.body ? 'POST' : 'GET'),
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const result = await response.json().catch(() => ({ ok: false, message: 'تعذر قراءة استجابة الخادم' }));
  if (!response.ok) {
    const error = new Error(result.message || 'تعذر إكمال الطلب');
    error.status = response.status;
    error.details = result.details;
    throw error;
  }
  return result;
}

function showScreen(name, push = true) {
  const target = $(`[data-screen="${name}"]`);
  if (!target) return;
  const current = $('.screen.active')?.dataset.screen;
  if (push && current && current !== name) state.navigation.push(current);
  $$('.screen').forEach((screen) => screen.classList.toggle('active', screen === target));
  const authenticated = !['auth', 'otp'].includes(name);
  $('#app-header').classList.toggle('hidden', !authenticated);
  $('#back-button').classList.toggle('hidden', ['dashboard', 'profile'].includes(name));
  if (name !== 'tracking') stopTracking();
  history.replaceState(null, '', `#${name}`);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  window.MusirI18n?.apply(target);
}

function navigateBack() {
  const previous = state.navigation.pop() || 'dashboard';
  showScreen(previous, false);
}

function toast(message, type = '') {
  const element = $('#toast');
  element.textContent = t(message);
  element.className = `toast show ${type}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { element.className = 'toast'; }, 4200);
}

function loading(show, message = 'جاري المعالجة...') {
  $('#loading-message').textContent = t(message);
  $('#loading-overlay').classList.toggle('hidden', !show);
}

function normalizePhoneInput(value) {
  const digits = String(value).replace(/\D/g, '');
  if (digits.startsWith('966')) return digits;
  if (digits.startsWith('05')) return `966${digits.slice(1)}`;
  if (digits.startsWith('5')) return `966${digits}`;
  return digits;
}

async function requestOtp(event, forcedPhone) {
  event?.preventDefault();
  const phone = normalizePhoneInput(forcedPhone || $('#phone').value);
  if (!/^9665\d{8}$/.test(phone)) return toast('أدخل رقم جوال سعودي صحيح', 'error');
  loading(true, 'جاري إنشاء رمز التحقق...');
  try {
    const result = await api('/api/auth/request-otp', { auth: false, body: { phone } });
    state.phone = result.phone;
    $('#otp-phone').textContent = `+${result.phone}`;
    if (result.debugCode) {
      $('#demo-code').textContent = `${t('رمز التحقق الخاص بك')}: ${result.debugCode}`;
      $('#demo-code').classList.remove('hidden');
    } else {
      $('#demo-code').classList.add('hidden');
    }
    $('#otp-code').value = '';
    showScreen('otp');
    setTimeout(() => $('#otp-code').focus(), 100);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    loading(false);
  }
}

async function verifyOtp(event) {
  event.preventDefault();
  const code = $('#otp-code').value.replace(/\D/g, '');
  if (code.length !== 6) return toast('أدخل رمز التحقق المكون من 6 أرقام', 'error');
  loading(true, 'جاري التحقق...');
  try {
    const result = await api('/api/auth/verify-otp', { auth: false, body: { phone: state.phone, code } });
    state.token = result.token;
    state.user = result.user;
    localStorage.setItem('musir-token', state.token);
    await loadAccount();
    showScreen(state.user.profileComplete ? 'dashboard' : 'profile');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    loading(false);
  }
}

async function startNafath() {
  try {
    await api('/api/auth/nafath', { auth: false, body: {} });
  } catch (error) {
    toast(error.message);
  }
}

async function loadAccount() {
  const result = await api('/api/me');
  state.user = result.user;
  state.tickets = result.tickets;
  fillProfile();
  renderDashboard();
}

function fillProfile() {
  if (!state.user) return;
  $('#profile-name').value = state.user.fullName || '';
  $('#profile-id').value = state.user.nationalId || '';
  $('#profile-expiry').value = state.user.nationalIdExpiry || '';
}

async function saveProfile(event) {
  event.preventDefault();
  const fullName = $('#profile-name').value.trim();
  const nationalId = $('#profile-id').value.replace(/\D/g, '');
  const nationalIdExpiry = $('#profile-expiry').value;
  if (!fullName || !/^\d{10}$/.test(nationalId) || !nationalIdExpiry) return toast('أكمل جميع بيانات الحساب بشكل صحيح', 'error');
  loading(true, 'جاري حفظ البيانات...');
  try {
    const result = await api('/api/me/profile', { method: 'PUT', body: { fullName, nationalId, nationalIdExpiry } });
    state.user = result.user;
    renderDashboard();
    showScreen('dashboard');
    toast('تم حفظ بيانات الحساب', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    loading(false);
  }
}

function setToday() {
  const language = window.MusirI18n?.language || 'ar';
  const locale = language === 'en' ? 'en-GB' : language === 'ur' ? 'ur-PK' : 'ar-SA';
  const date = new Date();
  const long = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(date);
  if ($('#today-label')) $('#today-label').textContent = long;
  if ($('#trip-date')) $('#trip-date').textContent = long;
}

function formatDate(value, includeTime = false) {
  if (!value) return '—';
  const language = window.MusirI18n?.language || 'ar';
  const locale = language === 'en' ? 'en-GB' : language === 'ur' ? 'ur-PK' : 'ar-SA';
  return new Intl.DateTimeFormat(locale, includeTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(new Date(value));
}

function statusText(status) {
  return t({ active: 'سارية', expired: 'منتهية', cancelled: 'ملغاة', none: 'لا توجد تذكرة' }[status] || status);
}

function renderDashboard() {
  if (!state.user) return;
  const firstName = state.user.fullName?.split(/\s+/)[0] || t('سائقنا');
  $('#driver-first-name').textContent = firstName;
  $('#driver-avatar').textContent = firstName.charAt(0) || 'م';
  $('#active-count').textContent = state.tickets.filter((ticket) => ticket.status === 'active').length;
  $('#total-count').textContent = state.tickets.length;
  const list = $('#ticket-list');
  list.innerHTML = state.tickets.map((ticket) => `
    <article class="ticket-item" data-ticket-id="${escapeHtml(ticket.id)}">
      <div>
        <h3>${escapeHtml(t(ticket.crossingPoint.name))}</h3>
        <div class="ticket-meta"><span>🚛 ${escapeHtml(ticket.truckPlateNumber)}</span><span>📅 ${formatDate(ticket.issuedAt)}</span><span>🏢 ${escapeHtml(ticket.companyName)}</span></div>
        <div class="ticket-number">${escapeHtml(ticket.ticketNumber)}</div>
      </div>
      <span class="status-pill ${ticket.status}">${statusText(ticket.status)}</span>
    </article>`).join('');
  $('#tickets-empty').classList.toggle('hidden', state.tickets.length > 0);
  window.MusirI18n?.apply(list);
}

function startNewTicket() {
  state.documentResults = {};
  state.files = {};
  state.ticketDraft = {};
  $$('.upload-card').forEach(resetUploadCard);
  $('#extracted-card').classList.add('hidden');
  $('#extracted-fields').innerHTML = '';
  $('#missing-fields-notice').classList.add('hidden');
  showScreen('documents');
}

function resetUploadCard(card) {
  card.classList.remove('complete', 'error');
  $('.status-chip', card).className = 'status-chip idle';
  $('.status-chip', card).textContent = t('مطلوب');
  $('.upload-preview', card).innerHTML = `<span>${t('ارفع صورة واضحة للمستند')}</span>`;
  $('.upload-error', card).textContent = '';
  $$('input', card).forEach((input) => { input.value = ''; });
}

async function handleDocumentFile(card, file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return markUploadError(card, 'صيغة الملف غير مدعومة');
  if (file.size > 12 * 1024 * 1024) return markUploadError(card, 'حجم الصورة كبير جدًا');
  const type = card.dataset.document;
  const previewUrl = URL.createObjectURL(file);
  $('.upload-preview', card).innerHTML = `<img src="${previewUrl}" alt="${t('مستند')}">`;
  const chip = $('.status-chip', card);
  chip.className = 'status-chip loading';
  chip.textContent = t('جاري التحليل');
  card.classList.remove('complete', 'error');
  $('.upload-error', card).textContent = '';
  try {
    const dataUrl = await compressImage(file);
    const result = await api('/api/documents/analyze', { body: { documentType: type, dataUrl } });
    const required = REQUIRED_BY_DOCUMENT[type];
    const missing = required.filter((key) => !String(result.fields[key] || '').trim());
    if (missing.length) {
      delete state.documentResults[type];
      markUploadError(card, `${t('تعذر قراءة')}: ${missing.map((key) => t(FIELD_CONFIG[key].label)).join('، ')}. ${t('أعد رفع صورة أوضح.')}`);
      return;
    }
    state.documentResults[type] = result.fields;
    state.files[type] = { name: file.name, analyzedAt: new Date().toISOString() };
    card.classList.add('complete');
    chip.className = 'status-chip complete';
    chip.textContent = t('مكتمل');
    const allDocumentsComplete = Object.keys(REQUIRED_BY_DOCUMENT).every((documentType) => state.documentResults[documentType]);
    if (allDocumentsComplete) renderExtractedFields();
    else {
      $('#extracted-card').classList.add('hidden');
      $('#extracted-fields').innerHTML = '';
    }
  } catch (error) {
    delete state.documentResults[type];
    markUploadError(card, error.message);
  } finally {
    URL.revokeObjectURL(previewUrl);
  }
}

function markUploadError(card, message) {
  card.classList.add('error');
  const chip = $('.status-chip', card);
  chip.className = 'status-chip error';
  chip.textContent = t('ناقص');
  $('.upload-error', card).textContent = message;
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('تعذر قراءة الصورة'));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error('الصورة غير صالحة'));
      image.onload = () => {
        const max = 1800;
        const scale = Math.min(1, max / Math.max(image.width, image.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', .84));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function combinedFields() {
  return {
    ...(state.documentResults.identity || {}),
    ...(state.documentResults.vehicle_license || {}),
    ...(state.documentResults.company_permit || {}),
    fullName: state.user?.fullName || '',
    nationalId: state.user?.nationalId || '',
    nationalIdExpiry: state.user?.nationalIdExpiry || ''
  };
}

function renderExtractedFields() {
  const allDocumentsComplete = Object.keys(REQUIRED_BY_DOCUMENT).every((type) => state.documentResults[type]);
  if (!allDocumentsComplete) {
    $('#extracted-card').classList.add('hidden');
    return;
  }
  const fields = { ...combinedFields(), ...state.ticketDraft };
  $('#extracted-card').classList.remove('hidden');
  $('#extracted-fields').innerHTML = Object.entries(FIELD_CONFIG).map(([key, config]) => `
    <div class="field-wrap ${config.source === 'account' ? 'account' : ''}">
      <label for="field-${key}"><span>${t(config.label)}</span><span class="field-source">${t(config.source === 'account' ? 'بيانات الحساب' : 'مستند')}</span></label>
      <input id="field-${key}" data-field="${key}" type="${config.type || 'text'}" value="${escapeHtml(fields[key] || '')}" ${config.readonly ? 'readonly' : ''}>
    </div>`).join('');
  window.MusirI18n?.apply($('#extracted-fields'));
}

function continueFromDocuments() {
  const missingDocuments = Object.keys(REQUIRED_BY_DOCUMENT).filter((type) => !state.documentResults[type]);
  if (missingDocuments.length) return toast('ارفع المستندات الثلاثة وأكمل تحليلها أولًا', 'error');
  const values = {};
  $$('[data-field]', $('#extracted-fields')).forEach((input) => { values[input.dataset.field] = input.value.trim(); });
  const required = Object.keys(FIELD_CONFIG);
  const missing = required.filter((key) => !values[key]);
  if (missing.length) {
    $('#missing-fields-notice').textContent = `${t('البيانات الناقصة')}: ${missing.map((key) => t(FIELD_CONFIG[key].label)).join('، ')}`;
    $('#missing-fields-notice').classList.remove('hidden');
    const documentToRetry = FIELD_CONFIG[missing[0]]?.document;
    if (documentToRetry) markUploadError($(`.upload-card[data-document="${documentToRetry}"]`), 'أعد رفع هذا المستند لاكتمال بيانات التذكرة.');
    return;
  }
  state.ticketDraft = values;
  $('#missing-fields-notice').classList.add('hidden');
  renderRoutes();
  showScreen('route');
}

function renderRoutes() {
  $('#route-list').innerHTML = state.points.map((point, index) => `
    <label class="route-option">
      <input type="radio" name="crossing-point" value="${escapeHtml(point.id)}" ${index === 0 ? 'checked' : ''}>
      <span class="route-pin">⌖</span>
      <span><strong>${escapeHtml(t(point.name))}</strong><small>${escapeHtml(t(point.route))}</small></span>
    </label>`).join('');
  window.MusirI18n?.apply($('#route-list'));
  setToday();
}

function getCustomLocation() {
  if (!navigator.geolocation) return toast('الجهاز لا يدعم تحديد الموقع', 'error');
  $('#custom-location-status').textContent = t('جاري تحديد الموقع...');
  navigator.geolocation.getCurrentPosition((position) => {
    state.customLocation = { lat: position.coords.latitude, lng: position.coords.longitude };
    $('#custom-location-status').textContent = `${t('تم تحديد الموقع')} (${position.coords.accuracy.toFixed(0)}m)`;
  }, (error) => {
    $('#custom-location-status').textContent = '';
    toast(locationError(error), 'error');
  }, { enableHighAccuracy: true, timeout: 15000 });
}

async function issueTicket(event) {
  event.preventDefault();
  const selected = $('input[name="crossing-point"]:checked');
  if (!selected) return toast('اختر نقطة عبور', 'error');
  const body = { crossingPointId: selected.value, fields: state.ticketDraft };
  if (selected.value === 'custom') {
    body.customPointName = $('#custom-point-name').value.trim();
    body.customLat = state.customLocation?.lat;
    body.customLng = state.customLocation?.lng;
    if (!body.customPointName || !state.customLocation) return toast('أدخل اسم النقطة وحدد موقعها', 'error');
  }
  loading(true, 'جاري إصدار التذكرة...');
  try {
    const result = await api('/api/tickets', { body });
    state.currentTicket = result.ticket;
    state.tickets.unshift(result.ticket);
    renderTicketPass(result.ticket);
    showScreen('success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    loading(false);
  }
}

function renderTicketPass(ticket) {
  $('#ticket-pass').innerHTML = `
    <div class="ticket-pass-head"><div><small>${t('رقم التذكرة')}</small><h2>${escapeHtml(ticket.ticketNumber)}</h2></div><span class="status-pill active">${t('سارية')}</span></div>
    <div class="ticket-pass-grid">
      <span>${t('نقطة العبور')}<strong>${escapeHtml(t(ticket.crossingPoint.name))}</strong></span>
      <span>${t('لوحة الشاحنة')}<strong>${escapeHtml(ticket.truckPlateNumber)}</strong></span>
      <span>${t('الشركة')}<strong>${escapeHtml(ticket.companyName)}</strong></span>
      <span>${t('تنتهي')}<strong>${formatDate(ticket.expiresAt, true)}</strong></span>
    </div>`;
  window.MusirI18n?.apply($('#ticket-pass'));
}

function openTracking(ticket) {
  if (!ticket) return;
  state.currentTicket = ticket;
  $('#tracking-title').textContent = t(ticket.crossingPoint.name);
  $('#tracking-subtitle').textContent = `${ticket.ticketNumber} • ${ticket.truckPlateNumber}`;
  showScreen('tracking');
  setTimeout(() => initializeMap(ticket), 80);
}

function initializeMap(ticket) {
  const destination = [Number(ticket.crossingPoint.lat) || 18.2465, Number(ticket.crossingPoint.lng) || 42.5117];
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  if (!window.L) {
    $('#tracking-state').textContent = t('تعذر تحميل الخريطة');
    $('#tracking-map').innerHTML = `<div class="map-fallback"><span>⌖</span><strong>${t('الخريطة غير متاحة دون اتصال')}</strong><small>${t('سيستمر حفظ التذكرة، وتظهر الخريطة عند توفر اتصال بالإنترنت.')}</small></div>`;
    return;
  }
  state.map = L.map('tracking-map').setView(destination, 10);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(state.map);
  L.marker(destination).addTo(state.map).bindPopup(escapeHtml(ticket.crossingPoint.name));
  startTracking(ticket);
}

function startTracking(ticket) {
  if (!navigator.geolocation) {
    $('#tracking-state').textContent = t('الجهاز لا يدعم تحديد الموقع');
    return;
  }
  stopTracking(false);
  state.watchId = navigator.geolocation.watchPosition((position) => {
    const point = [position.coords.latitude, position.coords.longitude];
    $('#tracking-state').textContent = t('التتبع مباشر الآن');
    $('#tracking-accuracy').textContent = `${t('دقة الموقع')}: ${position.coords.accuracy.toFixed(0)}m`;
    if (!state.marker) state.marker = L.marker(point).addTo(state.map).bindPopup(t('موقع الشاحنة الحالي'));
    else state.marker.setLatLng(point);
    const destination = [Number(ticket.crossingPoint.lat), Number(ticket.crossingPoint.lng)];
    if (destination.every(Number.isFinite)) {
      if (state.routeLine) state.routeLine.remove();
      state.routeLine = L.polyline([point, destination], { color: '#13b98e', weight: 5, dashArray: '8 10' }).addTo(state.map);
      state.map.fitBounds(state.routeLine.getBounds(), { padding: [40, 40], maxZoom: 14 });
    } else state.map.setView(point, 14);
    if (Date.now() - state.lastLocationSentAt > 15000) {
      state.lastLocationSentAt = Date.now();
      api(`/api/tickets/${encodeURIComponent(ticket.id)}/locations`, { body: { lat: point[0], lng: point[1], accuracy: position.coords.accuracy } }).catch(console.warn);
    }
  }, (error) => {
    $('#tracking-state').textContent = t(locationError(error));
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

function stopTracking(updateText = true) {
  if (state.watchId !== null) navigator.geolocation.clearWatch(state.watchId);
  state.watchId = null;
  state.marker = null;
  state.routeLine = null;
  if (updateText && $('#tracking-state')) $('#tracking-state').textContent = t('تم إيقاف التتبع');
}

function locationError(error) {
  if (error?.code === 1) return 'يلزم السماح بالوصول إلى الموقع لبدء التتبع';
  if (error?.code === 2) return 'تعذر تحديد موقع الجهاز';
  return 'انتهت مهلة تحديد الموقع. حاول مجددًا';
}

function logout() {
  clearSession();
  showScreen('auth', false);
}

function clearSession() {
  stopTracking(false);
  localStorage.removeItem('musir-token');
  state.token = '';
  state.user = null;
  state.tickets = [];
  state.navigation = [];
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}
