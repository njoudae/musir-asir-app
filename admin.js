const $ = (selector, root = document) => root.querySelector(selector);
const t = (text) => window.MusirI18n?.t(text) || text;

const adminState = {
  token: sessionStorage.getItem('musir-admin-token') || '',
  data: null,
  map: null,
  markers: null,
  timer: null,
  refreshing: false
};

document.addEventListener('DOMContentLoaded', initializeAdmin);

function initializeAdmin() {
  $('#admin-login-form').addEventListener('submit', login);
  $('#admin-logout').addEventListener('click', logout);
  $('#refresh-dashboard').addEventListener('click', loadDashboard);
  $('#crossing-form').addEventListener('submit', recordCrossing);
  $('#vehicle-search').addEventListener('input', renderVehicles);
  window.addEventListener('musir:language', () => { setAdminDate(); if (adminState.data) renderDashboard(); });
  setAdminDate();
  if (adminState.token) openDashboard();
}

async function request(endpoint, options = {}) {
  const response = await fetch(endpoint, {
    method: options.body ? 'POST' : 'GET',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(adminState.token ? { Authorization: `Bearer ${adminState.token}` } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message || 'تعذر إكمال الطلب');
  return result;
}

async function login(event) {
  event.preventDefault();
  setLoading(true, 'جاري تسجيل الدخول...');
  try {
    const result = await request('/api/admin/login', { body: { pin: $('#admin-pin').value } });
    adminState.token = result.token;
    sessionStorage.setItem('musir-admin-token', result.token);
    await openDashboard();
  } catch (error) { toast(error.message, 'error'); }
  finally { setLoading(false); }
}

async function openDashboard() {
  $('#admin-login').classList.add('hidden');
  $('#admin-app').classList.remove('hidden');
  try { await loadDashboard(); }
  catch (error) { logout(); toast(error.message, 'error'); }
  clearInterval(adminState.timer);
  adminState.timer = setInterval(loadDashboard, 5000);
}

async function loadDashboard() {
  if (adminState.refreshing) return;
  adminState.refreshing = true;
  setLiveStatus('جاري التحديث...', 'syncing');
  try {
    const result = await request('/api/admin/dashboard');
    adminState.data = result;
    renderDashboard();
    setLiveStatus('متصل مباشرة', 'online');
  } catch (error) {
    setLiveStatus('تعذر التحديث', 'offline');
    throw error;
  } finally {
    adminState.refreshing = false;
  }
}

function renderDashboard() {
  const { stats, points } = adminState.data;
  $('#stat-active').textContent = stats.activeTickets;
  $('#stat-tracked').textContent = stats.trackedTrucks;
  $('#stat-total').textContent = stats.totalTickets;
  $('#stat-violations').textContent = stats.violations;
  $('#map-count').textContent = `${stats.trackedTrucks} ${t('شاحنة')}`;
  $('#crossing-point').innerHTML = points.map((point) => `<option value="${escapeHtml(point.id)}">${escapeHtml(t(point.name))}</option>`).join('');
  renderVehicles();
  renderViolations();
  renderMap();
}

function renderVehicles() {
  if (!adminState.data) return;
  const term = $('#vehicle-search').value.trim().toLowerCase();
  const vehicles = adminState.data.vehicles.filter((item) => !term || `${item.truckPlateNumber} ${item.companyName} ${item.driver.fullName}`.toLowerCase().includes(term));
  $('#vehicles-body').innerHTML = vehicles.map((item) => `<tr>
    <td><span class="plate">${escapeHtml(item.truckPlateNumber)}</span></td><td>${escapeHtml(item.driver.fullName)}</td><td>${escapeHtml(item.companyName)}</td>
    <td>${escapeHtml(t(item.crossingPoint.name))}</td><td dir="ltr">${escapeHtml(item.ticketNumber)}</td><td><span class="status-pill ${item.status}">${statusText(item.status)}</span></td>
    <td>${item.latestLocation ? `${formatDate(item.latestLocation.recordedAt)}<small class="location-freshness ${locationFreshness(item.latestLocation.recordedAt).className}">${escapeHtml(t(locationFreshness(item.latestLocation.recordedAt).label))}</small>` : '—'}</td></tr>`).join('');
  $('#vehicles-empty').classList.toggle('hidden', vehicles.length > 0);
}

function renderViolations() {
  const violations = adminState.data.violations;
  $('#violations-body').innerHTML = violations.map((item) => `<tr><td><span class="plate">${escapeHtml(item.plate)}</span></td><td>${escapeHtml(t(item.crossingPoint.name))}</td><td><span class="status-pill ${item.ticketStatus}">${statusText(item.ticketStatus)}</span></td><td>${escapeHtml(t(item.reason))}</td><td>${formatDate(item.createdAt)}</td></tr>`).join('');
  $('#violations-empty').classList.toggle('hidden', violations.length > 0);
}

function renderMap() {
  if (!window.L) {
    $('#admin-map').innerHTML = `<div class="map-fallback"><span>⌖</span><strong>${t('الخريطة غير متاحة دون اتصال')}</strong><small>${t('ستظهر مواقع الشاحنات عند توفر اتصال بخدمة الخرائط.')}</small></div>`;
    return;
  }
  if (!adminState.map) {
    adminState.map = L.map('admin-map').setView([18.2465, 42.5117], 9);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(adminState.map);
    adminState.markers = L.layerGroup().addTo(adminState.map);
  }
  adminState.markers.clearLayers();
  const bounds = [];
  for (const point of adminState.data.points) {
    L.circleMarker([point.lat, point.lng], { radius: 8, color: '#087157', fillColor: '#20d7aa', fillOpacity: .7 }).addTo(adminState.markers).bindPopup(escapeHtml(point.name));
  }
  for (const vehicle of adminState.data.vehicles) {
    const location = vehicle.latestLocation;
    if (!location) continue;
    const latLng = [location.lat, location.lng];
    bounds.push(latLng);
    const freshness = locationFreshness(location.recordedAt);
    L.marker(latLng).addTo(adminState.markers).bindPopup(`<strong>${escapeHtml(vehicle.truckPlateNumber)}</strong><br>${escapeHtml(vehicle.companyName)}<br>${statusText(vehicle.status)}<br><small>${escapeHtml(t(freshness.label))} • ${formatDate(location.recordedAt)}</small>`);
  }
  if (bounds.length) adminState.map.fitBounds(bounds, { padding: [45, 45], maxZoom: 13 });
  setTimeout(() => adminState.map.invalidateSize(), 50);
}

async function recordCrossing(event) {
  event.preventDefault();
  setLoading(true, 'جاري التحقق من التذكرة...');
  try {
    const result = await request('/api/admin/crossing-events', { body: { plate: $('#crossing-plate').value, crossingPointId: $('#crossing-point').value } });
    const box = $('#crossing-result');
    box.className = `crossing-result ${result.event.ticketStatus}`;
    box.innerHTML = `<strong>${statusText(result.event.ticketStatus)}</strong><small>${result.violationRecorded ? t('تم تسجيل مخالفة على الشاحنة') : t('تم السماح بالعبور وتسجيل العملية')}</small>${result.event.ticketNumber ? `<small>${escapeHtml(result.event.ticketNumber)}</small>` : ''}`;
    $('#crossing-plate').value = '';
    await loadDashboard();
  } catch (error) { toast(error.message, 'error'); }
  finally { setLoading(false); }
}

function logout() {
  clearInterval(adminState.timer);
  sessionStorage.removeItem('musir-admin-token');
  adminState.token = '';
  $('#admin-app').classList.add('hidden');
  $('#admin-login').classList.remove('hidden');
  $('#admin-pin').value = '';
}

function setAdminDate() {
  const lang = window.MusirI18n?.language || 'ar';
  const locale = lang === 'en' ? 'en-GB' : lang === 'ur' ? 'ur-PK' : 'ar-SA';
  $('#admin-date').textContent = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());
}

function setLiveStatus(label, state) {
  const badge = $('#live-status');
  if (!badge) return;
  badge.className = `live-badge ${state}`;
  const text = $('span', badge);
  if (text) text.textContent = t(label);
}

function locationFreshness(recordedAt) {
  const age = Date.now() - new Date(recordedAt).getTime();
  if (age <= 30000) return { className: 'live', label: 'موقع حي الآن' };
  if (age <= 120000) return { className: 'recent', label: 'موقع حديث' };
  return { className: 'stale', label: 'موقع قديم' };
}

function statusText(status) { return t({ active: 'سارية', expired: 'منتهية', none: 'لا توجد تذكرة', cancelled: 'ملغاة' }[status] || status); }
function formatDate(value) { const lang = window.MusirI18n?.language || 'ar'; return new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang === 'ur' ? 'ur-PK' : 'ar-SA', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }
function setLoading(show, text) { $('#loading-message').textContent = t(text || 'جاري المعالجة...'); $('#loading-overlay').classList.toggle('hidden', !show); }
function toast(message, type = '') { const el = $('#toast'); el.textContent = t(message); el.className = `toast show ${type}`; setTimeout(() => { el.className = 'toast'; }, 4000); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' }[c])); }
