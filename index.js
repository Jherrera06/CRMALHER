
const { onRequest } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const Busboy = require('busboy');

if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();
const bucket = admin.storage().bucket();

const VERIFY_TOKEN = String(process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
const DEFAULT_RESPONSABLE = String(process.env.DEFAULT_RESPONSABLE || 'superadm').trim();
const GRAPH_VERSION = String(process.env.WHATSAPP_API_VERSION || 'v23.0').trim();
const WHATSAPP_TOKEN = String(process.env.WHATSAPP_TOKEN || '').trim();
const DEFAULT_DISPLAY_NUMBER = '5493856894033';
const DEFAULT_PHONE_NUMBER_ID = '113013548315130';
const DEFAULT_WABA_ID = '942531718147656';
const PHONE_NUMBER_ID = String(process.env.WHATSAPP_PHONE_NUMBER_ID || DEFAULT_PHONE_NUMBER_ID).trim();
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const ALHER_FUNCTIONS_BUILD = 'v299_inbox_media_enter_sonido_agentes';
let metaPhoneAccessCache = { id: '', ok: null, at: 0, data: null, error: '' };

const API_SHARED_SECRET = String(process.env.ALHER_API_SHARED_SECRET || '').trim();
const CARTONES_SCAN_API_URL = String(process.env.CARTONES_SCAN_API_URL || '').trim();
const CARTONES_SCAN_API_KEY = String(process.env.CARTONES_SCAN_API_KEY || '').trim();
const CARTONES_SCAN_API_KEY_HEADER = String(process.env.CARTONES_SCAN_API_KEY_HEADER || 'Authorization').trim();


function cartonesIsGoogleVisionUrl(url = '') {
  return /vision\.googleapis\.com\/v\d+\/images:annotate/i.test(String(url || ''));
}

function cartonesDataUrlToBase64(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const comma = raw.indexOf(',');
  if (/^data:/i.test(raw) && comma >= 0) return raw.slice(comma + 1).trim();
  return raw.trim();
}

function cartonesExtractDataUrlMime(value = '') {
  const raw = String(value || '').trim();
  const m = raw.match(/^data:([^;]+);base64,/i);
  return m ? m[1] : '';
}

function cartonesApiUrlWithKey(url, key, headerName) {
  let out = String(url || '').trim();
  if (!key) return out;
  const h = String(headerName || '').trim().toLowerCase();
  if (h === 'x-goog-api-key' || h === 'key' || h === 'apikey') {
    try {
      const u = new URL(out);
      if (!u.searchParams.get('key')) u.searchParams.set('key', key);
      return u.toString();
    } catch (_e) {
      return out + (out.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
    }
  }
  return out;
}

function cartonesParseMoney(value = '') {
  let s = String(value || '').replace(/\s+/g, '').replace(/[^0-9.,-]/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function cartonesFindMoneyTokens(line = '') {
  const withoutDates = String(line || '').replace(/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/g, ' ');
  const tokens = withoutDates.match(/\$?\s*\d{1,3}(?:[\.\s]\d{3})*(?:,\d{1,2})?|\$?\s*\d+(?:,\d{1,2})?/g) || [];
  return tokens.map(cartonesParseMoney).filter(n => n > 0 && n < 100000000);
}

function cartonesNormalizeDate(raw = '') {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?$/);
  if (!m) return s;
  const dd = m[1].padStart(2, '0');
  const mm = m[2].padStart(2, '0');
  let yy = m[3] || '';
  if (yy.length === 2) yy = '20' + yy;
  return yy ? `${yy}-${mm}-${dd}` : `${dd}/${mm}`;
}

function cartonesParseOcrToReport(text = '', files = []) {
  const raw = String(text || '').trim();
  const lines = raw.split(/\r?\n+/).map(l => l.trim()).filter(Boolean);
  const items = [];
  const dudas = [];
  for (const line of lines) {
    const dateMatches = line.match(/\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b/g) || [];
    if (!dateMatches.length) continue;
    const amounts = cartonesFindMoneyTokens(line);
    if (!amounts.length) {
      dudas.push(`Fecha ${dateMatches[0]} detectada sin monto claro: ${line.slice(0, 120)}`);
      items.push({ fecha: cartonesNormalizeDate(dateMatches[0]), monto: 0, saldoOk: undefined, dudoso: true, texto: line, error: 'Monto ilegible o no detectado' });
      continue;
    }
    const monto = amounts[0] || 0;
    const saldoAnterior = amounts.length >= 3 ? amounts[1] : 0;
    const saldoRestante = amounts.length >= 2 ? amounts[amounts.length - 1] : 0;
    const saldoCalculado = saldoAnterior && monto ? Math.max(0, saldoAnterior - monto) : 0;
    const saldoOk = saldoAnterior && saldoRestante ? Math.abs(saldoRestante - saldoCalculado) <= 2 : undefined;
    if (saldoOk === false) dudas.push(`Revisar saldo en fecha ${dateMatches[0]}: detectado ${saldoRestante}, calculado ${saldoCalculado}`);
    items.push({
      fecha: cartonesNormalizeDate(dateMatches[0]),
      monto,
      saldoAnterior,
      saldoRestante,
      saldoCalculado,
      saldoOk,
      dudoso: saldoOk === false,
      texto: line,
      confidence: 0,
      error: saldoOk === false ? 'Diferencia de saldo detectada' : ''
    });
  }
  if (!raw) dudas.push('Google Vision no devolvió texto OCR. Revisar calidad de foto, foco o iluminación.');
  if (raw && !items.length) dudas.push('Se leyó texto, pero no se detectaron fechas y pagos con formato claro. Revisar el cartón manualmente.');
  const total = items.reduce((acc, it) => acc + (Number(it.monto) || 0), 0);
  const dates = new Set(items.map(it => it.fecha).filter(Boolean));
  const firstFile = files[0] || {};
  const original = String(firstFile.dataUrl || '').slice(0, 900000);
  const enhanced = String(firstFile.enhancedDataUrl || firstFile.dataUrl || '').slice(0, 900000);
  return {
    ok: true,
    provider: 'google_vision',
    totalPagado: total,
    cantidadFechasLeidas: dates.size || items.length,
    cuotasDetectadas: dates.size || items.length,
    casillerosDudosos: dudas,
    resultadoOCR: raw || 'Sin texto OCR detectado por Google Vision.',
    estado: dudas.length ? 'con_dudas' : 'procesado',
    diferenciasDetectada: dudas.length > 0,
    visionProcesado: true,
    imagenOriginalUrl: original,
    imagenMejoradaUrl: enhanced,
    items,
    detalle: items,
    pagos: items,
  };
}

async function callGoogleVisionForCartones(externalPayload, headers) {
  const files = Array.isArray(externalPayload.files) ? externalPayload.files : [];
  const imageFiles = files.filter(f => /^image\//i.test(String(f.type || cartonesExtractDataUrlMime(f.dataUrl || f.enhancedDataUrl || ''))) || /^data:image\//i.test(String(f.dataUrl || f.enhancedDataUrl || '')));
  if (!imageFiles.length) {
    return {
      ok: false,
      provider: 'google_vision',
      estado: 'error',
      visionProcesado: false,
      resultadoOCR: 'Google Vision directo acepta imágenes. Para PDF necesitás una API propia o convertir el PDF a imagen antes de subirlo.',
      casillerosDudosos: ['No se detectó ninguna imagen compatible para OCR.'],
      totalPagado: 0,
      cantidadFechasLeidas: 0,
      items: []
    };
  }
  const requests = imageFiles.map(f => ({
    image: { content: cartonesDataUrlToBase64(f.enhancedDataUrl || f.enhancedBase64 || f.dataUrl || f.base64 || '') },
    features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
    imageContext: { languageHints: ['es'] }
  })).filter(r => r.image.content);
  // Google Cloud Vision con API Key requiere identidad de consumidor.
  // Para evitar el error "Method doesn't allow unregistered callers",
  // enviamos la clave siempre como query param ?key=, aunque el .env tenga otro header.
  const url = cartonesApiUrlWithKey(CARTONES_SCAN_API_URL, CARTONES_SCAN_API_KEY, 'key');
  const visionHeaders = { 'Content-Type': 'application/json' };
  const apiResp = await fetch(url, { method: 'POST', headers: visionHeaders, body: JSON.stringify({ requests }) });
  const txt = await apiResp.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : {}; } catch (_e) { data = { raw: txt }; }
  if (!apiResp.ok) {
    const err = new Error(data?.error?.message || data?.error || data?.message || `Google Vision respondió ${apiResp.status}`);
    err.status = apiResp.status;
    err.data = data;
    throw err;
  }
  const responses = Array.isArray(data.responses) ? data.responses : [];
  const allText = responses.map(r => r?.fullTextAnnotation?.text || r?.textAnnotations?.[0]?.description || '').filter(Boolean).join('\n---\n');
  const report = cartonesParseOcrToReport(allText, imageFiles);
  report.rawVision = data;
  return report;
}

function requireCrmApiAuth(req, res) {
  if (!API_SHARED_SECRET) return true; // modo compatible: no rompe instalaciones existentes
  const header = String(req.headers['x-alher-api-key'] || req.headers['x-api-key'] || '').trim();
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (header === API_SHARED_SECRET || bearer === API_SHARED_SECRET) return true;
  res.status(401).json({ error: 'No autorizado para ejecutar acciones del CRM.' });
  return false;
}

const SALES_BOT_ENABLED = String(process.env.ALHER_SALES_BOT_ENABLED || 'true').trim().toLowerCase() !== 'false';
const SALES_BOT_IDLE_HOURS = Math.max(1, Number(process.env.ALHER_SALES_BOT_IDLE_HOURS || 5) || 5);
const SALES_BOT_IDLE_TEXT = String(process.env.ALHER_SALES_BOT_IDLE_TEXT || 'Hola, gracias por escribir a ALHER. Tu consulta quedó registrada. En breve un asesor va a continuar la atención por este medio.').trim();
const SALES_BOT_DERIVE_WORDS = ['asesor', 'humano', 'vendedor', 'presupuesto', 'precio', 'comprar', 'seña', 'senia', 'pagar', 'quiero avanzar', 'cerrar'];
const SALES_BOT_STOP_WORDS = ['stop', 'baja', 'cancelar bot', 'no bot'];

function normalizeBotText(text = '') {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function botIncludesAny(text = '', words = []) {
  const raw = normalizeBotText(text);
  return words.some((word) => raw.includes(normalizeBotText(word)));
}

function inferSalesNeed(text = '') {
  const raw = normalizeBotText(text);
  const rules = [
    ['placard', ['placard', 'ropero', 'vestidor']],
    ['cocina', ['cocina', 'bajo mesada', 'alacena', 'mesada']],
    ['local comercial', ['local', 'exhibidor', 'mostrador', 'gondola', 'comercial', 'bazar', 'deco']],
    ['dormitorio', ['dormitorio', 'cama', 'respaldo', 'mesa de luz']],
    ['living', ['living', 'rack', 'tv', 'biblioteca', 'sillon']],
    ['oficina', ['oficina', 'escritorio', 'recepcion']]
  ];
  for (const [label, words] of rules) {
    if (words.some((word) => raw.includes(word))) return label;
  }
  return '';
}

function textHasMeasures(text = '') {
  const raw = normalizeBotText(text);
  return /\b\d+[\.,]?\d*\s*(cm|mt|mts|m|metro|metros)\b/.test(raw) || /\b(alto|ancho|profundidad|medida|medidas)\b/.test(raw);
}

function textHasBudget(text = '') {
  const raw = normalizeBotText(text);
  return /\$\s*\d+|\b\d{4,}\b|presupuesto|economico|premium|financi/.test(raw);
}

async function sendBotText(phone, name, text) {
  if (!SALES_BOT_ENABLED || !text || !WHATSAPP_TOKEN || !PHONE_NUMBER_ID) return null;
  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: phone,
    type: 'text',
    text: { body: text },
  };
  const outboundPhoneId = await getOutboundPhoneNumberId(phone);
  const data = await graphFetchWithPhoneId(outboundPhoneId, 'messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const messageId = data?.messages?.[0]?.id || '';
  await saveOutgoingMessage({ phone, name: name || 'Cliente', text, type: 'bot', messageId, rawResponse: data });
  return { messageId, data };
}

async function handleSalesBotInbound(item, assignment = null) {
  if (!SALES_BOT_ENABLED) return { handled: false, reason: 'disabled' };
  const phone = item.wa_id;
  const name = item.contact_name || 'Cliente';
  const text = String(item.text || '').trim();
  if (!phone || !text) return { handled: false, reason: 'empty' };

  const sector = String(assignment?.sector || inferInboundSector(text) || '').trim().toLowerCase();
  if (sector === 'cobranzas') return { handled: false, reason: 'cobranzas' };

  const ref = db.collection('embudo').doc(phone);
  const snap = await ref.get().catch(() => null);
  const data = snap?.exists ? (snap.data() || {}) : {};
  const bot = data.bot || {};
  if (bot.status === 'derivado_humano' || bot.paused === true) return { handled: false, reason: 'human' };

  if (botIncludesAny(text, SALES_BOT_STOP_WORDS)) {
    await ref.set({ bot: { ...(bot || {}), paused: true, status: 'pausado', pausedAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    return { handled: false, reason: 'paused_by_client' };
  }

  const need = data.necesidad || data.tipo_producto || inferSalesNeed(text) || '';
  const hasMeasures = Boolean(data.tiene_medidas || bot.hasMeasures || textHasMeasures(text));
  const hasBudget = Boolean(data.tiene_presupuesto || bot.hasBudget || textHasBudget(text));
  const wantsHuman = botIncludesAny(text, SALES_BOT_DERIVE_WORDS);

  let stage = String(bot.stage || '').trim() || 'inicio';
  let reply = '';
  let status = 'conversando';
  let temperature = data.temperatura || data.lead_temperature || 'tibio';

  if (wantsHuman || (need && hasMeasures && hasBudget)) {
    stage = 'derivar';
    status = 'derivado_humano';
    temperature = 'caliente';
    reply = 'Perfecto. Ya dejé tu consulta preparada para que un asesor de ALHER continúe con la propuesta. En breve te van a responder con el siguiente paso.';
  } else if (!need) {
    stage = 'preguntar_necesidad';
    reply = 'Hola, soy el asistente de ALHER. Para ayudarte mejor: ¿qué necesitás armar o consultar? Por ejemplo placard, cocina, local comercial, exhibidor, dormitorio u oficina.';
  } else if (!hasMeasures) {
    stage = 'preguntar_medidas';
    reply = `Perfecto, registré la consulta por ${need}. ¿Tenés medidas aproximadas del espacio? Si podés, enviá alto, ancho y profundidad, o una foto del lugar.`;
  } else if (!hasBudget) {
    stage = 'preguntar_presupuesto';
    reply = 'Bien, con eso ya podemos orientarte mejor. ¿Buscás una opción económica, estándar o premium? También podés decirme un presupuesto aproximado.';
  } else {
    stage = 'derivar';
    status = 'derivado_humano';
    temperature = 'caliente';
    reply = 'Excelente, ya tengo los datos principales. Te derivo con un asesor para preparar la propuesta comercial.';
  }

  // v297: el bot NO responde inmediatamente. Solo deja datos de contexto y queda pendiente.
  // La respuesta automática se envía por scheduler si pasan 5 horas sin respuesta humana.
  await ref.set({
    origen: data.origen || 'whatsapp',
    sector: 'ventas',
    temperatura: temperature,
    lead_temperature: temperature,
    necesidad: need || data.necesidad || '',
    tipo_producto: need || data.tipo_producto || '',
    tiene_medidas: hasMeasures,
    tiene_presupuesto: hasBudget,
    bot: {
      ...(bot || {}),
      enabled: true,
      status: bot.status || 'esperando_humano',
      stage,
      pendingIdleReply: true,
      idleHours: SALES_BOT_IDLE_HOURS,
      suggestedReply: reply,
      lastInboundText: text,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    derivado_humano: status === 'derivado_humano' || data.derivado_humano === true,
  }, { merge: true });

  return { handled: false, status: 'pending_idle_reply', stage, temperature };
}


function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Alher-Api-Key, X-Api-Key');
}

function getNested(obj, path, fallback = undefined) {
  return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj) ?? fallback;
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function toIso(value) {
  if (!value) return new Date().toISOString();
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return new Date().toISOString();
}

function normalizeRole(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const map = {
    superadm: 'admin', super_admin: 'admin', superadmin: 'admin', admin: 'admin', administrador: 'admin',
    agent: 'agent', agente: 'agent', 'agente crm': 'agent',
    gestor: 'gestor', cobrador: 'cobrador', jefe: 'jefe', regional: 'regional',
    credito: 'credito', creditos: 'credito', 'créditos': 'credito',
    vendedor: 'vendedor', jefe_comercial: 'jefe_comercial', jefecomercial: 'jefe_comercial',
    recursos_humanos: 'recursos_humanos', rrhh: 'recursos_humanos'
  };
  return map[raw] || raw;
}

function parseRoleList(value, fallback = []) {
  if (Array.isArray(value)) return Array.from(new Set(value.map((item) => normalizeRole(item)).filter(Boolean)));
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return Array.from(new Set(raw.split(',').map((item) => normalizeRole(item)).filter(Boolean)));
}

function inferInboundSector(text = '') {
  const raw = String(text || '').toLowerCase();
  const debtWords = ['deuda', 'debo', 'debito', 'cuota', 'cuotas', 'vencimiento', 'vencida', 'recibo', 'cobranza', 'cobranzas', 'pago', 'pagar', 'cancelar', 'saldo'];
  return debtWords.some((word) => raw.includes(word)) ? 'cobranzas' : 'ventas';
}

function mapUserDoc(doc) {
  const data = doc.data() || {};
  return {
    docId: doc.id,
    id: String(data.id || doc.id || '').trim(),
    email: String(data.email || '').trim(),
    name: String(data.name || data.nombre || data.displayName || '').trim() || 'Agente',
    role: normalizeRole(data.role || data.rol || ''),
    roles: Array.from(new Set([
      normalizeRole(data.role || data.rol || ''),
      ...((Array.isArray(data.roles) ? data.roles : []).map(normalizeRole)),
      ...((Array.isArray(data.rolesMultiples) ? data.rolesMultiples : []).map(normalizeRole)),
    ].filter(Boolean))),
    active: data.active !== false && data.activo !== false && data.puede_iniciar !== false,
  };
}

async function getAutoAssignConfig() {
  const settings = await getGeneralSettings();
  return {
    enabled: settings.auto_assign_inbound !== false,
    sticky: settings.auto_assign_sticky !== false,
    ventasRoles: ['agent'],
    cobranzasRoles: parseRoleList(settings.auto_assign_cobranzas_roles, ['cobrador', 'gestor', 'jefe', 'credito', 'regional']),
  };
}

async function listAssignableUsers(roles = []) {
  // v263: automático solo a usuarios con rol explícito Agente CRM.
  // v297: para Inbox/Embudos también se respeta estado Activo/Inactivo del agente.
  const wanted = new Set(parseRoleList(roles && roles.length ? roles : ['agent']));
  if (!wanted.size) wanted.add('agent');
  const snap = await db.collection('usuarios').get();
  const base = snap.docs.map(mapUserDoc).filter((user) => user.active && (user.roles || [user.role]).some((r) => wanted.has(normalizeRole(r))));
  if (!wanted.has('agent')) return base;
  const statuses = await getAgentStatusMap();
  return base.filter((user) => {
    const key = String(user.id || user.docId || user.email || '').trim();
    const row = statuses.get(key) || statuses.get(String(user.email || '').trim());
    return !row || row.active !== false;
  });
}

async function getAgentStatusMap() {
  const snap = await db.collection('agentes_estado').limit(200).get().catch(() => null);
  const map = new Map();
  if (!snap) return map;
  snap.docs.forEach((doc) => {
    const d = doc.data() || {};
    const row = { id: String(d.id || d.agentId || doc.id || '').trim(), email: String(d.email || '').trim(), name: String(d.name || d.nombre || '').trim(), active: d.active !== false, updatedAt: toIso(d.updatedAt || d.fecha_actualizacion || '') };
    if (row.id) map.set(row.id, row);
    if (row.email) map.set(row.email, row);
  });
  return map;
}

async function listAgentStatusPayload() {
  const snap = await db.collection('usuarios').get().catch(() => null);
  const statuses = await getAgentStatusMap();
  const users = snap ? snap.docs.map(mapUserDoc).filter((u) => u.roles.includes('agent') || u.role === 'agent') : [];
  return users.map((u) => {
    const key = String(u.id || u.docId || u.email || '').trim();
    const row = statuses.get(key) || statuses.get(String(u.email || '').trim()) || {};
    return { id: key, agentId: key, email: u.email, name: u.name, role: u.role, active: row.active !== false, updatedAt: row.updatedAt || '' };
  });
}

async function saveAgentStatus(payload = {}) {
  const agentId = String(payload.agentId || payload.id || payload.email || '').trim();
  if (!agentId) throw Object.assign(new Error('Falta agentId.'), { status: 400 });
  const active = payload.active !== false;
  const ref = db.collection('agentes_estado').doc(agentId);
  const data = {
    id: agentId,
    agentId,
    active,
    name: String(payload.name || payload.nombre || '').trim(),
    email: String(payload.email || '').trim(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAtIso: new Date().toISOString(),
  };
  await ref.set(data, { merge: true });
  return { ...data, updatedAt: data.updatedAtIso };
}

function userMatchesIdentifier(user, identifier) {
  const key = String(identifier || '').trim();
  if (!key) return false;
  return [user.id, user.docId, user.email].map((v) => String(v || '').trim()).includes(key);
}

async function resolveExistingOwnerForPhone(phone, users = []) {
  const contactSnap = await db.collection('contactos').doc(phone).get().catch(() => null);
  const embudoSnap = await db.collection('embudo').doc(phone).get().catch(() => null);
  const identifiers = [];
  if (contactSnap?.exists) {
    const data = contactSnap.data() || {};
    identifiers.push(data.ownerId, data.agentId, data.responsable);
  }
  if (embudoSnap?.exists) {
    const data = embudoSnap.data() || {};
    identifiers.push(data.ownerId, data.agentId, data.responsable);
  }
  const clean = identifiers.map((item) => String(item || '').trim()).filter(Boolean);
  return users.find((user) => clean.some((identifier) => userMatchesIdentifier(user, identifier))) || null;
}

async function pickRoundRobinUser(users = [], sector = 'ventas') {
  if (!users.length) return null;
  const stateRef = db.collection('configuracion_general').doc('auto_assignment_state');
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    const data = snap.exists ? (snap.data() || {}) : {};
    const key = `${sector}_index`;
    const current = Number(data[key] || 0) || 0;
    const user = users[current % users.length] || users[0];
    tx.set(stateRef, {
      [key]: (current + 1) % users.length,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return user;
  });
}

async function assignIncomingOwner(phone, text = '') {
  const config = await getAutoAssignConfig();
  if (!config.enabled) return null;
  const sector = inferInboundSector(text);

  // v297: sticky real. Si ya existe un dueño en contacto/embudo, se conserva aunque el agente esté inactivo.
  // El estado inactivo solo evita recibir chats NUEVOS.
  const contactSnap = await db.collection('contactos').doc(phone).get().catch(() => null);
  const embudoSnap = await db.collection('embudo').doc(phone).get().catch(() => null);
  const existingOwner = String((embudoSnap?.get?.('ownerId') || embudoSnap?.get?.('agentId') || embudoSnap?.get?.('responsable') || contactSnap?.get?.('ownerId') || contactSnap?.get?.('agentId') || contactSnap?.get?.('responsable') || '') || '').trim();
  if (existingOwner) {
    const ownerName = String((embudoSnap?.get?.('ownerName') || contactSnap?.get?.('ownerName') || contactSnap?.get?.('responsableNombre') || '') || '').trim();
    return { sector: String(embudoSnap?.get?.('sector') || contactSnap?.get?.('sector') || sector || '').trim() || sector, ownerId: existingOwner, ownerName, ownerRole: String(embudoSnap?.get?.('ownerRole') || contactSnap?.get?.('ownerRole') || '').trim(), agentId: existingOwner, responsable: existingOwner, stickyExisting: true };
  }

  const roles = sector === 'cobranzas' ? config.cobranzasRoles : config.ventasRoles;
  const users = await listAssignableUsers(roles);
  if (!users.length) return null;
  const chosen = await pickRoundRobinUser(users, sector);
  if (!chosen) return null;
  return {
    sector,
    ownerId: chosen.id || chosen.docId || chosen.email,
    ownerName: chosen.name,
    ownerRole: chosen.role,
    agentId: chosen.id || chosen.docId || chosen.email,
    responsable: chosen.id || chosen.docId || chosen.email,
  };
}


function sanitizeFileName(value) {
  return String(value || 'archivo')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'archivo';
}

function proxyMediaPath(messageId) {
  return `/api/whatsapp/media?message_id=${encodeURIComponent(String(messageId || ''))}`;
}

async function fetchMetaMediaBuffer(mediaId) {
  if (!mediaId) throw new Error('Falta mediaId');
  const meta = await graphFetch(`${mediaId}`, { method: 'GET' });
  const mediaUrl = String(meta?.url || '').trim();
  if (!mediaUrl) throw new Error('Meta no devolvió URL para el media.');
  const response = await fetch(mediaUrl, { method: 'GET', headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    throw new Error(txt || `No se pudo descargar el media (${response.status})`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: String(meta?.mime_type || response.headers.get('content-type') || '').trim(),
    fileSize: Number(meta?.file_size || response.headers.get('content-length') || 0) || 0,
  };
}

async function persistMediaToStorage({ messageId, media = {}, direction = 'in' }) {
  const mediaId = String(media?.id || '').trim();
  if (!mediaId || !messageId) return media;
  const fetched = await fetchMetaMediaBuffer(mediaId);
  const extFromMime = (fetched.mimeType.split('/')[1] || '').replace(/[^a-zA-Z0-9]+/g, '');
  const baseName = sanitizeFileName(media?.filename || `${mediaId}.${extFromMime || 'bin'}`);
  const path = `whatsapp_media/${direction}/${sanitizeFileName(messageId)}_${baseName}`;
  const file = bucket.file(path);
  await file.save(fetched.buffer, {
    resumable: false,
    metadata: {
      contentType: fetched.mimeType || 'application/octet-stream',
      metadata: { media_id: mediaId, wa_message_id: String(messageId), direction },
    },
  });
  return {
    ...media,
    filename: media?.filename || baseName,
    mime_type: media?.mime_type || fetched.mimeType || 'application/octet-stream',
    file_size: media?.file_size || fetched.fileSize || fetched.buffer.length,
    storage_path: path,
    proxy_url: proxyMediaPath(messageId),
  };
}

function respondMediaBuffer(res, { buffer, mimeType = 'application/octet-stream', filename = 'archivo', download = false }) {
  const safeName = sanitizeFileName(filename || 'archivo');
  res.set('Content-Type', String(mimeType || 'application/octet-stream').trim() || 'application/octet-stream');
  res.set('Cache-Control', 'private, max-age=300');
  if (download) res.set('Content-Disposition', `attachment; filename="${safeName}"`);
  return res.status(200).send(buffer);
}

function inferMimeTypeFromFilename(fileName = '') {
  const name = String(fileName || '').trim().toLowerCase();
  if (!name) return '';
  if (/\.(jpe?g)$/.test(name)) return 'image/jpeg';
  if (/\.png$/.test(name)) return 'image/png';
  if (/\.gif$/.test(name)) return 'image/gif';
  if (/\.webp$/.test(name)) return 'image/webp';
  if (/\.(ogg|opus)$/.test(name)) return 'audio/ogg';
  if (/\.(m4a|mp4)$/.test(name)) return 'audio/mp4';
  if (/\.mp3$/.test(name)) return 'audio/mpeg';
  if (/\.aac$/.test(name)) return 'audio/aac';
  if (/\.amr$/.test(name)) return 'audio/amr';
  if (/\.wav$/.test(name)) return 'audio/wav';
  if (/\.pdf$/.test(name)) return 'application/pdf';
  return '';
}

function sanitizeUploadedMimeType(raw, fileName = '') {
  const clean = String(raw || '').split(';')[0].trim().toLowerCase();
  return clean || inferMimeTypeFromFilename(fileName) || 'application/octet-stream';
}

function isAllowedOutgoingAudioMime(mimeType = '') {
  return ['audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/amr'].includes(String(mimeType || '').trim().toLowerCase());
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    const fields = {};
    let fileBuffer = null;
    let fileName = '';
    let mimeType = '';
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (_name, file, info) => {
      fileName = info?.filename || '';
      mimeType = info?.mimeType || '';
      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    busboy.on('error', reject);
    busboy.on('finish', () => resolve({ fields, fileBuffer, fileName, mimeType: sanitizeUploadedMimeType(mimeType, fileName) }));
    busboy.end(req.rawBody);
  });
}

function parseIncomingMessages(body) {
  const items = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];

  for (const entry of entries) {
    for (const change of entry?.changes || []) {
      if (change?.field !== 'messages') continue;
      const value = change?.value || {};
      const contacts = Array.isArray(value?.contacts) ? value.contacts : [];
      const byWaId = new Map(contacts.map((c) => [String(c?.wa_id || ''), c]));
      const messages = Array.isArray(value?.messages) ? value.messages : [];

      for (const msg of messages) {
        const waId = normalizePhone(msg?.from);
        if (!waId) continue;

        const contact = byWaId.get(waId) || {};
        const type = String(msg?.type || 'text');
        const text =
          getNested(msg, 'text.body', '') ||
          getNested(msg, 'image.caption', '') ||
          getNested(msg, 'document.caption', '') ||
          getNested(msg, 'video.caption', '') ||
          '';
        const mediaNode = msg?.image || msg?.document || msg?.audio || msg?.video || msg?.sticker || null;
        const atIso = msg?.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : new Date().toISOString();

        items.push({
          id: String(msg?.id || ''),
          wa_message_id: String(msg?.id || ''),
          wa_id: waId,
          dir: 'in',
          type,
          text,
          at: atIso,
          updatedAt: new Date().toISOString(),
          contact_name: getNested(contact, 'profile.name', 'Cliente'),
          displayPhoneNumber: value?.metadata?.display_phone_number || '',
          phoneNumberId: value?.metadata?.phone_number_id || '',
          media: mediaNode ? {
            id: mediaNode?.id || '',
            mime_type: mediaNode?.mime_type || '',
            filename: mediaNode?.filename || '',
            sha256: mediaNode?.sha256 || '',
          } : null,
          raw: msg,
          rawEnvelope: body,
        });
      }
    }
  }

  return items;
}

function parseStatuses(body) {
  const out = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    for (const change of entry?.changes || []) {
      const value = change?.value || {};
      for (const st of value?.statuses || []) {
        out.push({
          id: `${String(st?.id || '')}:${String(st?.status || '')}:${String(st?.timestamp || Date.now())}`,
          wa_message_id: String(st?.id || ''),
          status: String(st?.status || ''),
          at: st?.timestamp ? new Date(Number(st.timestamp) * 1000).toISOString() : new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          recipient_id: String(st?.recipient_id || ''),
          conversation: st?.conversation || null,
          pricing: st?.pricing || null,
          raw: st,
        });
      }
    }
  }
  return out;
}

async function upsertContact(phone, name, atIso, extras = {}) {
  const ref = db.collection('contactos').doc(phone);
  const snap = await ref.get();
  const contactName = String(name || snap?.get?.('nombre_wsp') || snap?.get?.('whatsappProfileName') || snap?.get?.('nombre') || 'Cliente').trim() || 'Cliente';
  const payload = {
    telefono: phone,
    phone,
    nombre: contactName,
    name: contactName,
    cliente: contactName,
    nombre_wsp: contactName,
    whatsappProfileName: contactName,
    profileName: contactName,
    estado: 'nuevo',
    fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp(),
    ultima_actividad: atIso,
    ultimo_mensaje: extras.lastMessage || snap?.get?.('ultimo_mensaje') || '',
    ultimo_sentido: extras.direction || snap?.get?.('ultimo_sentido') || 'entrante',
  };
  if (!snap.exists) payload.fecha_creacion = admin.firestore.FieldValue.serverTimestamp();
  if (extras.ownerId || extras.agentId || extras.responsable) {
    payload.ownerId = extras.ownerId || extras.agentId || extras.responsable;
    payload.agentId = extras.agentId || extras.ownerId || extras.responsable;
    payload.responsable = extras.responsable || extras.ownerId || extras.agentId;
  }
  if (extras.ownerName) payload.ownerName = extras.ownerName;
  if (extras.ownerRole) payload.ownerRole = extras.ownerRole;
  if (extras.sector) payload.sector = extras.sector;
  await ref.set(payload, { merge: true });
}

async function ensureEmbudo(phone, atIso, extras = {}) {
  const ref = db.collection('embudo').doc(phone);
  const snap = await ref.get();
  const currentEtapa = snap.exists ? (snap.get('etapa') || snap.get('etapa_actual') || 'nuevo') : 'nuevo';
  const owner = extras.responsable || extras.ownerId || extras.agentId || (snap.exists ? (snap.get('responsable') || snap.get('ownerId') || snap.get('agentId')) : DEFAULT_RESPONSABLE) || DEFAULT_RESPONSABLE;
  const payload = {
    telefono: phone,
    phone,
    contactId: phone,
    cliente: extras.contactName || extras.nombre_wsp || (snap.exists ? (snap.get('cliente') || snap.get('nombre') || '') : '') || 'Cliente',
    clientName: extras.contactName || extras.nombre_wsp || (snap.exists ? (snap.get('clientName') || snap.get('cliente') || '') : '') || 'Cliente',
    nombre_wsp: extras.contactName || extras.nombre_wsp || (snap.exists ? (snap.get('nombre_wsp') || '') : ''),
    whatsappProfileName: extras.contactName || extras.nombre_wsp || (snap.exists ? (snap.get('whatsappProfileName') || '') : ''),
    etapa: currentEtapa || 'nuevo',
    etapa_actual: currentEtapa || 'nuevo',
    stage: currentEtapa || 'nuevo',
    status: snap.exists ? (snap.get('status') || snap.get('estado') || 'open') : 'open',
    estado: snap.exists ? (snap.get('estado') || 'nuevo') : 'nuevo',
    origen: 'whatsapp',
    fuente: 'whatsapp_inbox',
    ultima_actualizacion: atIso,
    updatedAt: atIso,
    ultimo_mensaje: extras.lastMessage || '',
    lastMessage: extras.lastMessage || '',
    ultimo_sentido: extras.direction || 'entrante',
    lastInboundAt: (extras.direction || 'entrante') === 'entrante' ? atIso : (snap.exists ? (snap.get('lastInboundAt') || snap.get('ultimo_entrante_at') || '') : ''),
    ultimo_entrante_at: (extras.direction || 'entrante') === 'entrante' ? atIso : (snap.exists ? (snap.get('ultimo_entrante_at') || snap.get('lastInboundAt') || '') : ''),
    lastInboundMessageId: extras.messageId || extras.waMessageId || (snap.exists ? (snap.get('lastInboundMessageId') || '') : ''),
    ultimo_entrante_id: extras.messageId || extras.waMessageId || (snap.exists ? (snap.get('ultimo_entrante_id') || '') : ''),
    responsable: owner,
    ownerId: extras.ownerId || extras.agentId || extras.responsable || owner,
    agentId: extras.agentId || extras.ownerId || extras.responsable || owner,
  };
  if (!snap.exists) {
    payload.fecha = admin.firestore.FieldValue.serverTimestamp();
    payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
    payload.titulo = `Consulta WhatsApp ${phone}`;
    payload.title = payload.titulo;
  }
  if (extras.ownerName) payload.ownerName = extras.ownerName;
  if (extras.ownerRole) payload.ownerRole = extras.ownerRole;
  if (extras.sector) payload.sector = extras.sector;
  await ref.set(payload, { merge: true });
}

async function saveHistorial(phone, name, text, atIso, assignment = null) {
  await db.collection('historial_gestiones').add({
    telefono: phone,
    cliente: name || 'Cliente',
    gestor: assignment?.ownerId || DEFAULT_RESPONSABLE,
    gestor_nombre: assignment?.ownerName || '',
    sector: assignment?.sector || '',
    accion: 'mensaje_recibido',
    detalle: text || '',
    fecha: admin.firestore.FieldValue.serverTimestamp(),
    fecha_evento: atIso,
    estado: 'nuevo',
  });
}


async function getGeneralSettings() {
  const snap = await db.collection('configuracion_general').doc('main').get();
  const data = snap.exists ? (snap.data() || {}) : {};
  // v249: Meta/WhatsApp se toma siempre desde functions/.env.
  // Los valores guardados en Firestore/Ajustes no deben pisar ni confundir el envío real.
  return {
    ...data,
    api_servidor: '',
    numero_visible: data.numero_visible || DEFAULT_DISPLAY_NUMBER,
    phone_number_id: PHONE_NUMBER_ID || data.phone_number_id || DEFAULT_PHONE_NUMBER_ID,
    waba_id: data.waba_id || DEFAULT_WABA_ID,
    meta_env_source: 'functions.env',
  };
}

async function saveGeneralSettings(payload = {}, actor = 'sistema') {
  const clean = {
    // v249: no guardar servidor ni IDs de Meta desde el navegador.
    // El envío usa exclusivamente WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID de functions/.env.
    api_servidor: '',
    numero_visible: String(payload.numero_visible || payload.displayNumber || DEFAULT_DISPLAY_NUMBER).trim(),
    phone_number_id: PHONE_NUMBER_ID || DEFAULT_PHONE_NUMBER_ID,
    waba_id: String(payload.waba_id || payload.wabaId || DEFAULT_WABA_ID).trim(),
    template_name: String(payload.template_name || payload.templateName || '').trim(),
    template_language: String(payload.template_language || payload.templateLang || 'es_AR').trim() || 'es_AR',
    auto_assign_inbound: payload.auto_assign_inbound !== false && payload.autoAssignInbound !== false,
    auto_assign_sticky: payload.auto_assign_sticky !== false && payload.autoAssignSticky !== false,
    auto_assign_ventas_roles: 'agent',
    auto_assign_cobranzas_roles: String(payload.auto_assign_cobranzas_roles || payload.autoAssignCobranzasRoles || 'cobrador,gestor,jefe,credito,regional').trim(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: actor,
  };
  await db.collection('configuracion_general').doc('main').set(clean, { merge: true });
  return await getGeneralSettings();
}


async function listStoredTemplates() {
  const snap = await db.collection('whatsapp_templates').orderBy('updatedAt', 'desc').limit(200).get().catch(() => null);
  if (!snap) return [];
  return snap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function saveTemplateRecord(template = {}, actor = 'crm') {
  const name = String(template.name || '').trim();
  if (!name) throw new Error('Falta nombre de plantilla.');
  const ref = db.collection('whatsapp_templates').doc(name);
  const payload = {
    id: name,
    name,
    displayName: String(template.displayName || template.display_name || name).trim(),
    category: String(template.category || 'UTILITY').trim() || 'UTILITY',
    language: String(template.language || 'es_AR').trim() || 'es_AR',
    body: String(template.body || '').trim(),
    footer: String(template.footer || '').trim(),
    status: String(template.status || 'draft').trim() || 'draft',
    shared: template.shared !== false,
    source: String(template.source || 'crm').trim() || 'crm',
    rejectionReason: String(template.rejectionReason || template.rejected_reason || '').trim(),
    quality: template.quality || template.quality_score || '',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: actor,
  };
  payload.createdAt = template.createdAt || admin.firestore.FieldValue.serverTimestamp();
  await ref.set(payload, { merge: true });
  const saved = await ref.get();
  return { id: ref.id, ...(saved.data() || {}) };
}

function templateToMetaPayload(template = {}) {
  const body = String(template.body || '').trim();
  if (!body) throw new Error('Falta el cuerpo de la plantilla.');
  const components = [{ type: 'BODY', text: body }];
  const footer = String(template.footer || '').trim();
  if (footer) components.push({ type: 'FOOTER', text: footer });
  return {
    name: String(template.name || '').trim(),
    category: String(template.category || 'UTILITY').trim() || 'UTILITY',
    language: String(template.language || 'es_AR').trim() || 'es_AR',
    components,
  };
}

async function getWabaId() {
  const settings = await getGeneralSettings();
  const wabaId = String(settings?.waba_id || '').trim();
  if (!wabaId) throw new Error('Falta WABA ID en Ajustes generales.');
  return wabaId;
}

function normalizeMetaTemplate(item = {}) {
  const bodyComponent = Array.isArray(item.components) ? item.components.find((c) => String(c.type || '').toUpperCase() === 'BODY') : null;
  const footerComponent = Array.isArray(item.components) ? item.components.find((c) => String(c.type || '').toUpperCase() === 'FOOTER') : null;
  return {
    id: String(item.id || item.name || ''),
    name: String(item.name || '').trim(),
    displayName: String(item.name || '').trim(),
    category: String(item.category || 'UTILITY').trim() || 'UTILITY',
    language: String(item.language || 'es_AR').trim() || 'es_AR',
    body: String(bodyComponent?.text || '').trim(),
    footer: String(footerComponent?.text || '').trim(),
    status: String(item.status || 'submitted').trim() || 'submitted',
    source: 'meta',
    quality: item.quality_score || item.qualityScore || '',
    rejectionReason: item.rejected_reason || item.rejection_reason || '',
    raw: item,
  };
}

async function fetchMetaTemplates() {
  const wabaId = await getWabaId();
  const query = new URLSearchParams({
    limit: '100',
    fields: 'name,status,language,category,components,quality_score,rejected_reason,id',
  });
  const data = await graphFetch(`${wabaId}/message_templates?${query.toString()}`, { method: 'GET' });
  const items = Array.isArray(data?.data) ? data.data : [];
  return items.map(normalizeMetaTemplate);
}

async function createMetaTemplate(template = {}, actor = 'crm') {
  const wabaId = await getWabaId();
  const payload = templateToMetaPayload(template);
  const data = await graphFetch(`${wabaId}/message_templates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const saved = await saveTemplateRecord({
    ...template,
    status: String(data?.status || 'submitted').trim() || 'submitted',
    source: 'meta',
  }, actor);
  return { template: saved, raw: data };
}

async function syncMetaTemplates(actor = 'crm') {
  const remote = await fetchMetaTemplates();
  for (const item of remote) {
    await saveTemplateRecord(item, actor);
  }
  return await listStoredTemplates();
}

async function getLatestInboundWindow(phone) {
  const snap = await db.collection('mensajes')
    .where('telefono', '==', phone)
    .where('dir', '==', 'in')
    .orderBy('timestamp', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return { open: false, lastInboundAt: null };
  const data = snap.docs[0].data() || {};
  const ts = data.timestamp;
  const dt = ts?.toDate ? ts.toDate() : (data.at ? new Date(data.at) : null);
  if (!dt || Number.isNaN(dt.getTime())) return { open: false, lastInboundAt: null };
  const expires = dt.getTime() + (24 * 60 * 60 * 1000);
  return {
    open: expires > Date.now(),
    lastInboundAt: dt.toISOString(),
    expiresAt: new Date(expires).toISOString(),
  };
}

async function saveOutgoingMessage({ phone, name, text, type = 'text', messageId = '', rawResponse = null, media = null }) {
  const atIso = new Date().toISOString();
  const ref = messageId ? db.collection('mensajes').doc(messageId) : db.collection('mensajes').doc();
  const contactSnap = await db.collection('contactos').doc(phone).get().catch(() => null);
  const embudoSnap = await db.collection('embudo').doc(phone).get().catch(() => null);
  const existingOwner = String((embudoSnap?.get?.('ownerId') || embudoSnap?.get?.('agentId') || embudoSnap?.get?.('responsable') || contactSnap?.get?.('ownerId') || contactSnap?.get?.('agentId') || contactSnap?.get?.('responsable') || DEFAULT_RESPONSABLE) || '').trim() || DEFAULT_RESPONSABLE;
  const existingOwnerName = String((contactSnap?.get?.('ownerName') || '') || '').trim();
  const existingOwnerRole = String((contactSnap?.get?.('ownerRole') || '') || '').trim();
  const existingSector = String((embudoSnap?.get?.('sector') || contactSnap?.get?.('sector') || '') || '').trim();
  await ref.set({
    telefono: phone,
    mensaje: text,
    origen: 'crm',
    estado: 'enviado',
    timestamp: admin.firestore.Timestamp.fromDate(new Date(atIso)),
    updatedAt: atIso,
    tipo: type,
    dir: 'out',
    wa_id: phone,
    wa_message_id: messageId || ref.id,
    at: atIso,
    contact_name: name || 'Cliente',
    nombre_contacto: name || 'Cliente',
    ownerId: existingOwner,
    agentId: existingOwner,
    responsable: existingOwner,
    ownerName: existingOwnerName,
    ownerRole: existingOwnerRole,
    sector: existingSector,
    raw_response: rawResponse || null,
    media: media || null,
  }, { merge: true });

  await db.collection('contactos').doc(phone).set({
    telefono: phone,
    nombre: name || 'Cliente',
    ownerId: existingOwner,
    agentId: existingOwner,
    responsable: existingOwner,
    ownerName: existingOwnerName,
    ownerRole: existingOwnerRole,
    sector: existingSector,
    fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp(),
    ultima_actividad: atIso,
    ultimo_mensaje: text,
    ultimo_sentido: 'saliente',
  }, { merge: true });

  const previousEtapa = String(embudoSnap?.get?.('etapa') || embudoSnap?.get?.('etapa_actual') || '').trim().toLowerCase();
  const nextEtapa = (!previousEtapa || ['nuevo','bot_calificando'].includes(previousEtapa)) ? 'contactado' : (embudoSnap?.get?.('etapa') || embudoSnap?.get?.('etapa_actual') || 'contactado');
  await db.collection('embudo').doc(phone).set({
    telefono: phone,
    phone,
    contactId: phone,
    etapa: nextEtapa,
    etapa_actual: nextEtapa,
    stage: nextEtapa,
    origen: 'whatsapp',
    fuente: 'crm_outbox',
    responsable: existingOwner,
    ownerId: existingOwner,
    agentId: existingOwner,
    sector: existingSector,
    status: 'open',
    ultima_actualizacion: atIso,
    updatedAt: atIso,
    ultimo_mensaje: text,
    lastMessage: text,
    ultimo_sentido: type === 'bot' ? 'saliente_bot' : 'saliente',
    lastOutboundAt: atIso,
    ultimo_saliente_at: atIso,
    lastOutboundMessageId: messageId || ref.id,
  }, { merge: true });

  await db.collection('historial_gestiones').add({
    telefono: phone,
    cliente: name || 'Cliente',
    gestor: existingOwner,
    gestor_nombre: existingOwnerName,
    sector: existingSector,
    accion: 'mensaje_enviado',
    detalle: text || '',
    fecha: admin.firestore.FieldValue.serverTimestamp(),
    fecha_evento: atIso,
    estado: 'contactado',
  });

  return { atIso };
}


function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTemplateParams(rawVars) {
  if (Array.isArray(rawVars)) return rawVars.map((v) => ({ type: 'text', text: String(v ?? '') }));
  if (rawVars && typeof rawVars === 'object') return Object.values(rawVars).map((v) => ({ type: 'text', text: String(v ?? '') }));
  return [];
}

async function sendSingleFromCRM({ to, text = '', contactName = 'Cliente', templateName = '', language = 'es_AR', variables = {} }) {
  const phone = normalizePhone(to);
  if (!phone) throw new Error('Falta destino.');

  const general = await getGeneralSettings();
  const windowInfo = await getLatestInboundWindow(phone);
  let payload;
  let mode = 'text';
  let renderedText = String(text || '').trim();

  if (windowInfo.open && renderedText) {
    payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone,
      type: 'text',
      text: { body: renderedText },
    };
  } else {
    const finalTemplateName = String(templateName || general.template_name || '').trim();
    const finalLanguage = String(language || general.template_language || 'es_AR').trim() || 'es_AR';
    if (!finalTemplateName) {
      throw new Error('La ventana de 24 horas está cerrada y falta una plantilla aprobada.');
    }
    const params = buildTemplateParams(variables);
    payload = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'template',
      template: {
        name: finalTemplateName,
        language: { code: finalLanguage },
      },
    };
    if (params.length) payload.template.components = [{ type: 'body', parameters: params }];
    mode = 'template';
    renderedText = `[Plantilla] ${finalTemplateName}`;
  }

  const outboundPhoneId = await getOutboundPhoneNumberId(phone);
  const data = await graphFetchWithPhoneId(outboundPhoneId, 'messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const messageId = data?.messages?.[0]?.id || '';
  await saveOutgoingMessage({ phone, name: contactName, text: renderedText, type: mode, messageId, rawResponse: data });
  return {
    ok: true,
    to: phone,
    contact_name: contactName,
    mode,
    message_id: messageId,
    rendered_text: renderedText,
    window_open: !!windowInfo.open,
    expires_at: windowInfo.expiresAt || null,
    raw: data,
    phone_number_id_used: outboundPhoneId,
  };
}

async function saveStatuses(statuses) {
  if (!statuses.length) return;
  const batch = db.batch();
  for (const item of statuses) {
    const ref = db.collection('mensajes_estados').doc(item.id);
    batch.set(ref, item, { merge: true });
  }
  await batch.commit();
}

async function fetchSnapshot(since, limitRaw) {
  const now = new Date().toISOString();
  const sinceMs = since ? Date.parse(String(since)) : 0;
  const limit = Math.max(20, Math.min(300, Number(limitRaw || 200)));

  const messagesSnap = await db.collection('mensajes').orderBy('timestamp', 'desc').limit(limit).get();
  let messages = messagesSnap.docs.map((doc) => {
    const d = doc.data() || {};
    const at = toIso(d.timestamp || d.updatedAt || d.at);
    return {
      id: doc.id,
      wa_message_id: d.wa_message_id || d.messageId || doc.id,
      wa_id: normalizePhone(d.telefono || d.wa_id || ''),
      dir: d.dir || (d.origen === 'whatsapp' ? 'in' : 'out'),
      type: d.tipo || d.type || 'text',
      text: d.mensaje || d.text || '',
      at,
      updatedAt: toIso(d.updatedAt || d.timestamp || d.at),
      contact_name: d.nombre_contacto || d.contact_name || d.nombre || 'Cliente',
      media: d.media || null,
      ownerId: d.ownerId || d.agentId || d.responsable || '',
      agentId: d.agentId || d.ownerId || d.responsable || '',
      responsable: d.responsable || d.ownerId || d.agentId || '',
      ownerName: d.ownerName || '',
      ownerRole: d.ownerRole || '',
      sector: d.sector || '',
    };
  }).filter((m) => m.wa_id);

  if (sinceMs) {
    messages = messages.filter((m) => Date.parse(m.updatedAt || m.at || 0) > sinceMs);
  }
  messages.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  let statuses = [];
  try {
    const statusesSnap = await db.collection('mensajes_estados').orderBy('updatedAt', 'desc').limit(limit).get();
    statuses = statusesSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    if (sinceMs) statuses = statuses.filter((s) => Date.parse(s.updatedAt || s.at || 0) > sinceMs);
    statuses.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  } catch (_e) {
    statuses = [];
  }

  let deals = [];
  try {
    let dealsSnap = null;
    try {
      dealsSnap = await db.collection('embudo').orderBy('ultima_actualizacion', 'desc').limit(200).get();
    } catch (_orderErr) {
      dealsSnap = await db.collection('embudo').limit(200).get();
    }
    deals = dealsSnap.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    if (sinceMs) {
      deals = deals.filter((d) => Date.parse(toIso(d.updatedAt || d.ultima_actualizacion || d.fecha_actualizacion || d.createdAt || d.fecha)) > sinceMs);
    }
  } catch (_e) {
    deals = [];
  }

  return { now, messages, statuses, deals };
}

async function getLatestInboundPhoneNumberId(phone = '') {
  const clean = normalizePhone(phone);
  if (!clean) return '';
  try {
    const snap = await db.collection('mensajes')
      .where('telefono', '==', clean)
      .where('dir', '==', 'in')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();
    if (!snap.empty) {
      const data = snap.docs[0].data() || {};
      return String(data.phone_number_id || data.phoneNumberId || '').trim();
    }
  } catch (err) {
    logger.warn('No se pudo resolver phone_number_id entrante', { phone: clean, error: err.message });
  }
  return '';
}

async function verifyPhoneNumberIdQuick(phoneNumberId = '') {
  const id = String(phoneNumberId || '').trim();
  if (!id) return { ok: false, error: 'Falta Phone Number ID.' };
  const now = Date.now();
  if (metaPhoneAccessCache.id === id && (now - Number(metaPhoneAccessCache.at || 0)) < 120000) {
    return metaPhoneAccessCache;
  }
  try {
    const data = await graphFetch(`${id}?fields=display_phone_number,verified_name,id`);
    metaPhoneAccessCache = { id, ok: true, at: now, data, error: '' };
    return metaPhoneAccessCache;
  } catch (err) {
    metaPhoneAccessCache = { id, ok: false, at: now, data: null, error: err.message || String(err), metaCode: err.meta_code || null, status: err.status || null };
    return metaPhoneAccessCache;
  }
}

async function getOutboundPhoneNumberId(phone = '') {
  // v294: usa el ID del .env solo si Meta confirma que el token tiene acceso.
  // Si el .env tiene WABA ID / Business ID por error, se usa como respaldo el phone_number_id
  // que llegó en el último webhook entrante de ese contacto. Esto evita el error:
  // Object with ID ... does not exist / missing permissions / endpoint messages.
  const envId = String(PHONE_NUMBER_ID || '').trim();
  const fromInbound = await getLatestInboundPhoneNumberId(phone);
  if (envId) {
    const envCheck = await verifyPhoneNumberIdQuick(envId);
    if (envCheck.ok) return envId;
    if (fromInbound && fromInbound !== envId) {
      const inboundCheck = await verifyPhoneNumberIdQuick(fromInbound);
      if (inboundCheck.ok) return fromInbound;
    }
    return envId;
  }
  return String(fromInbound || '').trim();
}

async function graphFetchWithPhoneId(phoneNumberId, endpointSuffix, options = {}) {
  const id = String(phoneNumberId || PHONE_NUMBER_ID || '').trim();
  if (!id) throw new Error('Falta WHATSAPP_PHONE_NUMBER_ID en functions/.env');
  return graphFetch(`${id}/${String(endpointSuffix || '').replace(/^\/+/, '')}`, options);
}

async function graphFetch(endpoint, options = {}) {
  if (!WHATSAPP_TOKEN) throw new Error('Falta WHATSAPP_TOKEN en functions/.env');
  if (!PHONE_NUMBER_ID) throw new Error('Falta WHATSAPP_PHONE_NUMBER_ID en functions/.env');
  const url = `${GRAPH_BASE}/${endpoint.replace(/^\/+/, '')}`;
  const headers = {
    Authorization: `Bearer ${WHATSAPP_TOKEN}`,
    ...(options.headers || {}),
  };
  const response = await fetch(url, { ...options, headers });
  const ct = response.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    const metaError = data?.error || {};
    const msg = metaError?.message || data?.message || `Error Graph API (${response.status})`;
    const err = new Error(msg);
    err.status = response.status;
    err.data = data;
    err.meta_code = metaError?.code || null;
    err.meta_type = metaError?.type || '';
    err.meta_fbtrace_id = metaError?.fbtrace_id || '';
    err.graph_endpoint = endpoint.replace(/^\/+/, '').replace(/access_token=[^&]+/i, 'access_token=***');
    throw err;
  }
  return data;
}

async function verifyMetaPhoneNumberAccess() {
  const startedAt = new Date().toISOString();
  if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
    return {
      ok: false,
      metaOk: false,
      startedAt,
      graphVersion: GRAPH_VERSION,
      phoneNumberId: PHONE_NUMBER_ID || '',
      whatsappTokenConfigured: !!WHATSAPP_TOKEN,
      error: !WHATSAPP_TOKEN ? 'Falta WHATSAPP_TOKEN en functions/.env' : 'Falta WHATSAPP_PHONE_NUMBER_ID en functions/.env',
    };
  }
  try {
    const data = await graphFetch(`${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,id`);
    return {
      ok: true,
      metaOk: true,
      startedAt,
      graphVersion: GRAPH_VERSION,
      phoneNumberId: PHONE_NUMBER_ID,
      whatsappTokenConfigured: true,
      displayPhoneNumber: data?.display_phone_number || '',
      verifiedName: data?.verified_name || '',
      id: data?.id || PHONE_NUMBER_ID,
    };
  } catch (error) {
    return {
      ok: true,
      metaOk: false,
      startedAt,
      graphVersion: GRAPH_VERSION,
      phoneNumberId: PHONE_NUMBER_ID,
      whatsappTokenConfigured: !!WHATSAPP_TOKEN,
      error: error.message || String(error),
      status: error.status || null,
      metaCode: error.meta_code || null,
      metaType: error.meta_type || '',
      fbtraceId: error.meta_fbtrace_id || '',
      graphEndpoint: error.graph_endpoint || `${PHONE_NUMBER_ID}?fields=display_phone_number,verified_name,id`,
      diagnostico: 'Si metaOk=false, Firebase leyó el .env pero Meta no autoriza ese WHATSAPP_TOKEN para ese Phone Number ID.',
    };
  }
}

function sanitizeGraphErrorForClient(error) {
  const raw = error.message || String(error);
  const expired = Number(error.meta_code || 0) === 190 || /validating access token|session has expired|token/i.test(String(raw || ''));
  const badObject = Number(error.meta_code || 0) === 100 || /Unsupported post request|Object with ID|missing permissions|does not support this operation/i.test(String(raw || ''));
  const friendly = expired
    ? 'Token de Meta vencido o inválido. Regenerá WHATSAPP_TOKEN en functions/.env y desplegá Functions.'
    : badObject
      ? 'Meta rechazó el envío porque el WHATSAPP_PHONE_NUMBER_ID no corresponde al número autorizado o el token no tiene permiso sobre ese activo. Revisá que no hayas pegado el WABA ID / Business ID en lugar del Phone Number ID.'
      : raw;
  return {
    error: friendly,
    rawError: raw,
    status: error.status || null,
    metaCode: error.meta_code || null,
    metaType: error.meta_type || '',
    fbtraceId: error.meta_fbtrace_id || '',
    graphEndpoint: error.graph_endpoint || '',
    phoneNumberId: PHONE_NUMBER_ID || '',
    graphVersion: GRAPH_VERSION,
    functionsBuild: ALHER_FUNCTIONS_BUILD,
    ayuda: expired
      ? 'El token de Meta caducó. Generá uno nuevo, pegalo en functions/.env y ejecutá firebase deploy --only functions.'
      : badObject
        ? 'En Meta Developers / WhatsApp / API Setup copiá Phone number ID, no WhatsApp Business Account ID. El token debe tener permiso whatsapp_business_messaging sobre ese número. Luego desplegá Functions.'
        : 'El backend llegó a Meta. Revisar permisos del token, número, app y cuenta de WhatsApp Business.',
  };
}

function normalizeStageKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

async function listAutomatedStages() {
  const snap = await db.collection('embudo_etapas').get().catch(() => null);
  if (!snap) return [];
  return snap.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: String(data.id || doc.id || '').trim(),
      name: String(data.name || data.nombre || doc.id || '').trim(),
      automationEnabled: data.automationEnabled === true || data.followup_enabled === true,
      templateName: String(data.followupTemplateName || data.templateName || data.followup_template_name || '').trim(),
      templateLanguage: String(data.followupTemplateLanguage || data.templateLanguage || data.followup_template_language || 'es_AR').trim() || 'es_AR',
      delayHours: Math.max(1, Number(data.followupDelayHours || data.followup_delay_hours || 24) || 24),
      followupOnlyIfNoReply: data.followupOnlyIfNoReply !== false && data.followup_only_if_no_reply !== false,
    };
  }).filter((stage) => stage.automationEnabled && stage.templateName);
}

function resolveStageAutomation(stageMap, stageId, stageName) {
  const keys = [stageId, stageName].map((item) => normalizeStageKey(item)).filter(Boolean);
  for (const key of keys) {
    if (stageMap.has(key)) return stageMap.get(key);
  }
  return null;
}

function embudoPhoneFromDoc(doc) {
  const data = doc.data() || {};
  return normalizePhone(data.telefono || data.phone || data.contactId || data.id || doc.id || '');
}

function stageUpdatedAtIso(data = {}) {
  return toIso(data.updatedAt || data.ultima_actualizacion || data.fecha_actualizacion || data.fecha || new Date().toISOString());
}

async function processStageAutomationsBatch() {
  const stages = await listAutomatedStages();
  if (!stages.length) return { ok: true, scanned: 0, eligible: 0, sent: 0, skipped: 0 };
  const stageMap = new Map();
  stages.forEach((stage) => {
    stageMap.set(normalizeStageKey(stage.id), stage);
    stageMap.set(normalizeStageKey(stage.name), stage);
  });

  const embudoSnap = await db.collection('embudo').limit(300).get().catch(() => null);
  if (!embudoSnap) return { ok: false, scanned: 0, eligible: 0, sent: 0, skipped: 0 };

  let scanned = 0;
  let eligible = 0;
  let sent = 0;
  let skipped = 0;

  for (const doc of embudoSnap.docs) {
    scanned += 1;
    const data = doc.data() || {};
    const stage = resolveStageAutomation(stageMap, data.stageId || data.etapa || data.etapa_actual || '', data.stage || data.etapa || data.etapa_actual || '');
    if (!stage) { skipped += 1; continue; }

    const phone = embudoPhoneFromDoc(doc);
    if (!phone) { skipped += 1; continue; }

    const stageUpdatedAt = stageUpdatedAtIso(data);
    const stageUpdatedMs = Date.parse(stageUpdatedAt || '') || 0;
    if (!stageUpdatedMs) { skipped += 1; continue; }

    const delayMs = stage.delayHours * 60 * 60 * 1000;
    if (Date.now() - stageUpdatedMs < delayMs) { skipped += 1; continue; }

    const alreadySentAt = String(data.followupAutomationSentAt || data.followup_automation_sent_at || '').trim();
    const alreadySentMs = alreadySentAt ? (Date.parse(alreadySentAt) || 0) : 0;
    const sentStageKey = normalizeStageKey(data.followupAutomationStageId || data.followup_automation_stage_id || '');
    const currentStageKey = normalizeStageKey(stage.id || stage.name || '');
    if (alreadySentMs && alreadySentMs >= stageUpdatedMs && sentStageKey === currentStageKey) {
      skipped += 1;
      continue;
    }

    const windowInfo = await getLatestInboundWindow(phone);
    if (windowInfo.open) { skipped += 1; continue; }

    eligible += 1;
    const contactSnap = await db.collection('contactos').doc(phone).get().catch(() => null);
    const contactName = String(contactSnap?.get?.('nombre') || data.cliente || data.nombre || 'Cliente').trim() || 'Cliente';
    try {
      const result = await sendSingleFromCRM({
        to: phone,
        text: '',
        contactName,
        templateName: stage.templateName,
        language: stage.templateLanguage,
        variables: {
          cliente: contactName,
          deuda: String(data.deuda_actual || data.debt || contactSnap?.get?.('deuda_actual') || 0),
          vencimiento: String(data.fecha_promesa_pago || data.dueDate || contactSnap?.get?.('fecha_promesa_pago') || ''),
        },
      });
      await doc.ref.set({
        followupAutomationSentAt: admin.firestore.FieldValue.serverTimestamp(),
        followupAutomationStageId: stage.id || stage.name,
        followupAutomationTemplate: stage.templateName,
        followupAutomationDelayHours: stage.delayHours,
        followupAutomationMessageId: String(result?.message_id || ''),
        followupAutomationError: '',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      sent += 1;
    } catch (err) {
      logger.error('Error en automatización por etapa', { phone, stage: stage.name, template: stage.templateName, error: err.message });
      await doc.ref.set({
        followupAutomationError: String(err.message || err || ''),
        followupAutomationLastAttemptAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  }

  return { ok: true, scanned, eligible, sent, skipped };
}


async function processIdleSalesBotRepliesBatch() {
  if (!SALES_BOT_ENABLED || !SALES_BOT_IDLE_TEXT) return { ok: true, scanned: 0, eligible: 0, sent: 0, skipped: 0, disabled: true };
  const snap = await db.collection('embudo').limit(500).get().catch(() => null);
  if (!snap) return { ok: false, scanned: 0, eligible: 0, sent: 0, skipped: 0 };
  const thresholdMs = SALES_BOT_IDLE_HOURS * 60 * 60 * 1000;
  let scanned = 0, eligible = 0, sent = 0, skipped = 0;
  for (const doc of snap.docs) {
    scanned += 1;
    const data = doc.data() || {};
    const phone = embudoPhoneFromDoc(doc);
    if (!phone) { skipped += 1; continue; }
    const bot = data.bot || {};
    if (bot.paused === true || bot.status === 'pausado') { skipped += 1; continue; }

    const lastInboundRaw = data.lastInboundAt || data.ultimo_entrante_at || (data.ultimo_sentido === 'entrante' ? (data.ultima_actualizacion || data.updatedAt) : '') || '';
    const lastInboundAt = lastInboundRaw ? toIso(lastInboundRaw) : '';
    const lastInboundMs = Date.parse(lastInboundAt || '') || 0;
    if (!lastInboundMs || Date.now() - lastInboundMs < thresholdMs) { skipped += 1; continue; }

    const lastOutboundRaw = data.lastOutboundAt || data.ultimo_saliente_at || '';
    const lastOutboundAt = lastOutboundRaw ? toIso(lastOutboundRaw) : '';
    const lastOutboundMs = Date.parse(lastOutboundAt || '') || 0;
    if (lastOutboundMs && lastOutboundMs >= lastInboundMs) { skipped += 1; continue; }

    const inboundKey = String(data.lastInboundMessageId || data.ultimo_entrante_id || lastInboundAt || '').trim();
    const alreadyFor = String(bot.idleReplyForInbound || '').trim();
    if (inboundKey && alreadyFor === inboundKey) { skipped += 1; continue; }

    eligible += 1;
    const contactSnap = await db.collection('contactos').doc(phone).get().catch(() => null);
    const contactName = String(contactSnap?.get?.('nombre') || data.cliente || data.nombre || 'Cliente').trim() || 'Cliente';
    const text = String(bot.suggestedReply || SALES_BOT_IDLE_TEXT).trim() || SALES_BOT_IDLE_TEXT;
    try {
      const result = await sendBotText(phone, contactName, text);
      await doc.ref.set({
        bot: {
          ...(bot || {}),
          status: 'respondio_demora_5h',
          lastReply: text,
          lastIdleReplyAt: admin.firestore.FieldValue.serverTimestamp(),
          idleReplyForInbound: inboundKey,
          pendingIdleReply: false,
          idleHours: SALES_BOT_IDLE_HOURS,
        },
        lastOutboundAt: new Date().toISOString(),
        ultimo_saliente_at: new Date().toISOString(),
        ultimo_mensaje: text,
        lastMessage: text,
        ultimo_sentido: 'saliente_bot',
        updatedAt: new Date().toISOString(),
        ultima_actualizacion: new Date().toISOString(),
      }, { merge: true });
      await db.collection('historial_gestiones').add({
        telefono: phone,
        cliente: contactName,
        gestor: 'bot_ventas_online',
        gestor_nombre: 'Bot ALHER',
        sector: 'ventas',
        accion: 'bot_responde_demora_5h',
        detalle: text,
        fecha: admin.firestore.FieldValue.serverTimestamp(),
        fecha_evento: new Date().toISOString(),
        estado: 'respondio_demora_5h',
        messageId: result?.messageId || '',
      });
      sent += 1;
    } catch (err) {
      logger.warn('Bot 5h no pudo responder', { phone, error: err.message });
      await doc.ref.set({ bot: { ...(bot || {}), idleReplyError: String(err.message || err || ''), idleReplyLastAttemptAt: admin.firestore.FieldValue.serverTimestamp() } }, { merge: true });
    }
  }
  return { ok: true, scanned, eligible, sent, skipped, idleHours: SALES_BOT_IDLE_HOURS };
}

exports.processEmbudoFollowups = onSchedule({ region: 'us-central1', schedule: 'every 15 minutes', timeZone: 'America/Argentina/Buenos_Aires' }, async () => {
  const result = await processStageAutomationsBatch();
  const botIdle = await processIdleSalesBotRepliesBatch();
  logger.info('Automatizaciones embudo ejecutadas', { followups: result, botIdle });
});

exports.alherWebhook = onRequest({ region: 'us-central1' }, async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).send('');
  }

  const path = (req.path || '/').replace(/\/+$/, '') || '/';

  if (path.startsWith('/api/') && req.method !== 'GET' && !requireCrmApiAuth(req, res)) return;

  try {
    if (path === '/api/health' && req.method === 'GET') {
      return res.json({
        status: 'ok',
        functionsBuild: ALHER_FUNCTIONS_BUILD,
        firestoreConfigured: true,
        verifyTokenConfigured: !!VERIFY_TOKEN,
        whatsappConfigured: !!(WHATSAPP_TOKEN && PHONE_NUMBER_ID),
        phoneNumberIdConfigured: !!PHONE_NUMBER_ID,
        phoneNumberId: PHONE_NUMBER_ID || '',
        whatsappTokenConfigured: !!WHATSAPP_TOKEN,
        salesBotEnabled: SALES_BOT_ENABLED,
        graphVersion: GRAPH_VERSION,
        metaConfigSource: 'functions.env',
      });
    }

    if (path === '/api/whatsapp/meta-diagnostico' && req.method === 'GET') {
      const diag = await verifyMetaPhoneNumberAccess();
      return res.json(diag);
    }

    if (path === '/api/whatsapp/outbound-diagnostico' && req.method === 'GET') {
      const to = normalizePhone(req.query?.to || '');
      const inboundPhoneId = await getLatestInboundPhoneNumberId(to);
      const envCheck = PHONE_NUMBER_ID ? await verifyPhoneNumberIdQuick(PHONE_NUMBER_ID) : { ok: false, error: 'Falta WHATSAPP_PHONE_NUMBER_ID' };
      const usedPhoneId = await getOutboundPhoneNumberId(to);
      let meta = null;
      try { meta = usedPhoneId ? await graphFetch(`${usedPhoneId}?fields=display_phone_number,verified_name,id`) : null; }
      catch (err) { meta = sanitizeGraphErrorForClient(err); }
      return res.json({
        ok: true,
        functionsBuild: ALHER_FUNCTIONS_BUILD,
        to,
        envPhoneNumberId: PHONE_NUMBER_ID || '',
        envPhoneNumberIdOk: !!envCheck.ok,
        envPhoneNumberIdError: envCheck.error || '',
        latestInboundPhoneNumberId: inboundPhoneId || '',
        phoneNumberIdUsed: usedPhoneId || '',
        meta,
        diagnostico: envCheck.ok ? 'El WHATSAPP_PHONE_NUMBER_ID del .env está autorizado.' : 'El WHATSAPP_PHONE_NUMBER_ID del .env no está autorizado por Meta. Revisar si pegaste WABA ID/Business ID en vez de Phone Number ID o si el token no tiene permisos sobre ese número.'
      });
    }

    if (path === '/api/inbox/agents/status' && req.method === 'GET') {
      const agents = await listAgentStatusPayload();
      return res.json({ ok: true, maxActiveAgents: 10, agents });
    }

    if (path === '/api/inbox/agents/status' && req.method === 'POST') {
      const status = await saveAgentStatus(req.body || {});
      return res.json({ ok: true, status });
    }

    if (path === '/api/inbox/assign' && req.method === 'POST') {
      const phone = normalizePhone(req.body?.phone || req.body?.to || req.body?.telefono || '');
      const agentId = String(req.body?.agentId || req.body?.ownerId || req.body?.responsable || '').trim();
      const agentName = String(req.body?.agentName || req.body?.ownerName || '').trim();
      if (!phone) return res.status(400).json({ error: 'Falta teléfono para asignar.' });
      const payload = {
        ownerId: agentId, agentId, responsable: agentId, ownerName: agentName, responsableNombre: agentName, assignmentLocked: !!agentId, assignedAt: admin.firestore.FieldValue.serverTimestamp(), fecha_actualizacion: admin.firestore.FieldValue.serverTimestamp(), updatedAt: new Date().toISOString(),
      };
      await db.collection('contactos').doc(phone).set(payload, { merge: true });
      await db.collection('embudo').doc(phone).set({ ...payload, telefono: phone, phone, contactId: phone, ultima_actualizacion: new Date().toISOString() }, { merge: true });
      return res.json({ ok: true, phone, agentId, agentName });
    }

    if (path === '/api/inbox/snapshot' && req.method === 'GET') {
      const snapshot = await fetchSnapshot(req.query?.since || '', req.query?.limit || '');
      return res.json(snapshot);
    }


    if (path === '/api/cartones/health' && req.method === 'GET') {
      return res.json({
        ok: true,
        configured: !!CARTONES_SCAN_API_URL,
        hasApiKey: !!CARTONES_SCAN_API_KEY,
        provider: cartonesIsGoogleVisionUrl(CARTONES_SCAN_API_URL) ? 'google_vision' : 'cartones_api',
        authMode: cartonesIsGoogleVisionUrl(CARTONES_SCAN_API_URL) ? 'query_key' : (CARTONES_SCAN_API_KEY_HEADER || 'Authorization'),
        googleVisionKeyMode: cartonesIsGoogleVisionUrl(CARTONES_SCAN_API_URL) ? 'url_query_param_key' : '',
        collection: 'controlCartones',
      });
    }

    if (path === '/api/cartones/scan' && req.method === 'POST') {
      if (!CARTONES_SCAN_API_URL) return res.status(501).json({ error: 'Falta configurar CARTONES_SCAN_API_URL en Functions.' });
      const body = req.body || {};
      const files = Array.isArray(body.files) ? body.files : Array.isArray(body.archivos) ? body.archivos : [];
      const cartonCase = body.case || body.caso || body.carton || {};
      if (!files.length) return res.status(400).json({ error: 'Faltan archivos para escanear.' });
      if (files.length > 8) return res.status(400).json({ error: 'Máximo 8 archivos por escaneo.' });
      const totalBytes = files.reduce((acc, f) => acc + Number(f.size || 0), 0);
      if (totalBytes > 14 * 1024 * 1024) return res.status(413).json({ error: 'Los archivos superan el máximo permitido de 14 MB.' });

      const externalPayload = {
        source: 'alher_crm',
        actor: String(body.actor || req.headers['x-user-email'] || 'crm').trim(),
        case: cartonCase,
        files: files.map((f) => ({
          name: String(f.name || 'archivo').slice(0, 180),
          type: String(f.type || 'application/octet-stream').slice(0, 120),
          size: Number(f.size || 0),
          dataUrl: String(f.dataUrl || ''),
          enhancedDataUrl: String(f.enhancedDataUrl || ''),
          base64: String(f.base64 || ''),
          enhancedBase64: String(f.enhancedBase64 || ''),
        })),
      };

      const startedAt = new Date().toISOString();
      let data;
      if (cartonesIsGoogleVisionUrl(CARTONES_SCAN_API_URL)) {
        data = await callGoogleVisionForCartones(externalPayload, {});
      } else {
        const headers = { 'Content-Type': 'application/json' };
        if (CARTONES_SCAN_API_KEY) {
          const headerName = CARTONES_SCAN_API_KEY_HEADER || 'Authorization';
          headers[headerName] = headerName.toLowerCase() === 'authorization' && !/^bearer\s+/i.test(CARTONES_SCAN_API_KEY) ? `Bearer ${CARTONES_SCAN_API_KEY}` : CARTONES_SCAN_API_KEY;
        }
        const apiResp = await fetch(CARTONES_SCAN_API_URL, { method: 'POST', headers, body: JSON.stringify(externalPayload) });
        const txt = await apiResp.text();
        try { data = txt ? JSON.parse(txt) : {}; } catch (_e) { data = { raw: txt }; }
        if (!apiResp.ok) {
          const err = new Error(data?.error || data?.message || `La API de cartones respondió ${apiResp.status}`);
          err.status = apiResp.status;
          err.data = data;
          throw err;
        }
      }

      await db.collection('controlCartonesEscaneos').add({
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        startedAt,
        finishedAt: new Date().toISOString(),
        provider: cartonesIsGoogleVisionUrl(CARTONES_SCAN_API_URL) ? 'google_vision' : 'cartones_api',
        actor: externalPayload.actor,
        caseId: String(cartonCase.id || ''),
        clientId: String(cartonCase.clientId || cartonCase.clienteId || ''),
        clientName: String(cartonCase.clientName || cartonCase.clienteNombre || ''),
        branchId: String(cartonCase.branchId || cartonCase.sucursalId || ''),
        branchName: String(cartonCase.branchName || cartonCase.sucursalNombre || ''),
        collectorId: String(cartonCase.collectorId || cartonCase.cobradorId || ''),
        collectorName: String(cartonCase.collectorName || cartonCase.cobradorNombre || ''),
        fileCount: files.length,
        totalBytes,
        ok: true,
      });

      return res.json({ ok: true, provider: cartonesIsGoogleVisionUrl(CARTONES_SCAN_API_URL) ? 'google_vision' : 'cartones_api', startedAt, finishedAt: new Date().toISOString(), result: data });
    }

    if (path === '/api/stream' && req.method === 'GET') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      res.write(`data: ${JSON.stringify({ event: 'ready', at: new Date().toISOString() })}\n\n`);
      const timer = setInterval(() => {
        try {
          res.write(`data: ${JSON.stringify({ event: 'ping', at: new Date().toISOString() })}\n\n`);
        } catch (_e) {}
      }, 25000);
      req.on('close', () => clearInterval(timer));
      return;
    }

    if (path === '/api/whatsapp/templates' && req.method === 'GET') {
      const doSync = String(req.query?.sync || '').trim() === '1';
      const templates = doSync ? await syncMetaTemplates('crm_sync') : await listStoredTemplates();
      return res.json({ ok: true, templates });
    }

    if (path === '/api/whatsapp/templates/save' && req.method === 'POST') {
      const actor = String(req.body?.actor || req.headers['x-user-email'] || 'crm').trim();
      const template = await saveTemplateRecord(req.body || {}, actor);
      return res.json({ ok: true, template });
    }

    if (path === '/api/whatsapp/templates/create-meta' && req.method === 'POST') {
      const actor = String(req.body?.actor || req.headers['x-user-email'] || 'crm').trim();
      const result = await createMetaTemplate(req.body || {}, actor);
      return res.json({ ok: true, ...result });
    }

    if (path === '/api/whatsapp/window-status' && req.method === 'GET') {
      const to = normalizePhone(req.query?.to || '');
      if (!to) return res.status(400).json({ error: 'Falta destino.' });
      const info = await getLatestInboundWindow(to);
      return res.json({ ok: true, to, ...info });
    }

    if (path === '/api/whatsapp/media' && req.method === 'GET') {
      const messageId = String(req.query?.message_id || '').trim();
      const download = String(req.query?.download || '') === '1';
      if (!messageId) return res.status(400).json({ error: 'Falta message_id.' });
      const msgRef = db.collection('mensajes').doc(messageId);
      const snap = await msgRef.get();
      if (!snap.exists) return res.status(404).json({ error: 'Mensaje no encontrado.' });
      const data = snap.data() || {};
      const media = data.media || {};
      const storagePath = String(media.storage_path || '').trim();
      const filename = sanitizeFileName(media.filename || `${messageId}`);
      const contentType = String(media.mime_type || 'application/octet-stream').trim() || 'application/octet-stream';

      if (storagePath) {
        const file = bucket.file(storagePath);
        const [exists] = await file.exists();
        if (exists) {
          const [buffer] = await file.download();
          return respondMediaBuffer(res, { buffer, mimeType: contentType, filename, download });
        }
      }

      // v299: fallback on-demand. Si el webhook no pudo guardar la imagen/audio en Storage,
      // intentamos recuperarlo directamente desde Meta usando el media.id del mensaje.
      const mediaId = String(media.id || media.media_id || '').trim();
      if (mediaId) {
        try {
          const fetched = await fetchMetaMediaBuffer(mediaId);
          let nextMedia = {
            ...media,
            filename: media.filename || filename,
            mime_type: media.mime_type || fetched.mimeType || contentType,
            file_size: media.file_size || fetched.fileSize || fetched.buffer.length,
            proxy_url: proxyMediaPath(messageId),
          };
          // Cachear en Storage si se puede, pero nunca bloquear la apertura por un error de Storage.
          try {
            nextMedia = await persistMediaToStorage({ messageId, media: nextMedia, direction: data.dir === 'out' ? 'out' : 'in' });
          } catch (storeErr) {
            logger.warn('Media recuperado desde Meta pero no cacheado en Storage', { messageId, mediaId, error: storeErr.message });
          }
          await msgRef.set({ media: nextMedia, updatedAt: new Date().toISOString() }, { merge: true }).catch(() => null);
          return respondMediaBuffer(res, { buffer: fetched.buffer, mimeType: nextMedia.mime_type || fetched.mimeType || contentType, filename: nextMedia.filename || filename, download });
        } catch (err) {
          const safe = sanitizeGraphErrorForClient(err);
          return res.status(err.status || 502).json({
            error: safe.error || 'No se pudo recuperar el archivo desde Meta.',
            detalle: 'El mensaje tiene media_id, pero Meta no autorizó la descarga o el token ya no tiene acceso. Actualizá WHATSAPP_TOKEN y volvé a intentar.',
            media_id: mediaId,
            metaCode: safe.metaCode || null,
            rawError: safe.rawError || '',
          });
        }
      }

      return res.status(404).json({ error: 'El media todavía no está disponible.', detalle: 'El mensaje no tiene archivo en Storage ni media_id de Meta para recuperarlo.' });
    }

    if (path === '/api/whatsapp/upload-media' && req.method === 'POST') {
      const parsed = await parseMultipart(req);
      if (!parsed?.fileBuffer?.length) return res.status(400).json({ error: 'Falta archivo.' });
      const safeMimeType = sanitizeUploadedMimeType(parsed.mimeType, parsed.fileName);
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('file', new Blob([parsed.fileBuffer], { type: safeMimeType }), parsed.fileName || 'archivo');
      const data = await graphFetch(`${PHONE_NUMBER_ID}/media`, { method: 'POST', body: form });
      return res.json({ ok: true, media_id: data?.id || '', id: data?.id || '', filename: parsed.fileName || '', mime_type: safeMimeType });
    }

    if (path === '/api/whatsapp/send-media' && req.method === 'POST') {
      const to = normalizePhone(req.body?.to);
      const mediaId = String(req.body?.media_id || req.body?.id || '').trim();
      const requestedMediaType = String(req.body?.media_type || 'document').trim();
      const caption = String(req.body?.caption || '').trim();
      const filename = String(req.body?.filename || '').trim();
      const mimeType = sanitizeUploadedMimeType(req.body?.mime_type, filename);
      const contactName = String(req.body?.contact_name || req.body?.name || 'Cliente').trim() || 'Cliente';
      if (!to || !mediaId) return res.status(400).json({ error: 'Faltan destino o media_id.' });
      const windowInfo = await getLatestInboundWindow(to);
      if (!windowInfo.open) return res.status(409).json({ error: 'Ventana de 24 horas cerrada. Para enviar adjuntos primero debe responder el cliente o usarse plantilla aprobada.', window_open: false, last_inbound_at: windowInfo.lastInboundAt || null });
      const mediaType = requestedMediaType === 'audio' && !isAllowedOutgoingAudioMime(mimeType) ? 'document' : requestedMediaType;
      const payload = { messaging_product: 'whatsapp', to, type: mediaType, [mediaType]: { id: mediaId } };
      if (caption && ['image', 'video', 'document'].includes(mediaType)) payload[mediaType].caption = caption;
      if (filename && mediaType === 'document') payload.document.filename = filename;
      const outboundPhoneId = await getOutboundPhoneNumberId(to);
      const data = await graphFetchWithPhoneId(outboundPhoneId, 'messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const messageId = data?.messages?.[0]?.id || '';
      if (!messageId) throw new Error('Meta no devolvió message_id para el adjunto.');
      await saveOutgoingMessage({ phone: to, name: contactName, text: caption || `[${mediaType}] ${filename || mediaId}`, type: mediaType, messageId, rawResponse: data, media: { id: mediaId, filename, mime_type: mimeType, proxy_url: '', storage_path: '', requested_type: requestedMediaType, sent_type: mediaType } });
      return res.json({ ok: true, message_id: messageId, sent_type: mediaType, mime_type: mimeType, phone_number_id_used: outboundPhoneId, ...data });
    }

    if (path === '/api/whatsapp/send-text' && req.method === 'POST') {
      const to = normalizePhone(req.body?.to);
      const text = String(req.body?.text || '').trim();
      if (!to || !text) return res.status(400).json({ error: 'Faltan destino o texto.' });
      const windowInfo = await getLatestInboundWindow(to);
      if (!windowInfo.open) return res.status(409).json({ error: 'Ventana de 24 horas cerrada. Usá una plantilla aprobada.', window_open: false, last_inbound_at: windowInfo.lastInboundAt || null });
      const outboundPhoneId = await getOutboundPhoneNumberId(to);
      const data = await graphFetchWithPhoneId(outboundPhoneId, 'messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text },
        }),
      });
      await saveOutgoingMessage({ phone: to, name: String(req.body?.contact_name || 'Cliente'), text, type: 'text', messageId: data?.messages?.[0]?.id || '', rawResponse: data });
      return res.json({ ok: true, message_id: data?.messages?.[0]?.id || '', phone_number_id_used: outboundPhoneId, ...data });
    }

    if (path === '/api/whatsapp/send-template' && req.method === 'POST') {
      const to = normalizePhone(req.body?.to);
      const templateName = String(req.body?.template_name || '').trim();
      const language = String(req.body?.language || 'es_AR').trim();
      if (!to || !templateName) return res.status(400).json({ error: 'Faltan destino o template_name.' });
      const params = buildTemplateParams(req.body?.variables);
      const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: language },
        },
      };
      if (params.length) payload.template.components = [{ type: 'body', parameters: params }];
      const outboundPhoneId = await getOutboundPhoneNumberId(to);
      const data = await graphFetchWithPhoneId(outboundPhoneId, 'messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await saveOutgoingMessage({ phone: to, name: String(req.body?.contact_name || 'Cliente'), text: `[Plantilla] ${templateName}`, type: 'template', messageId: data?.messages?.[0]?.id || '', rawResponse: data });
      return res.json({ ok: true, message_id: data?.messages?.[0]?.id || '', phone_number_id_used: outboundPhoneId, ...data });
    }

    if (path === '/api/settings/general' && req.method === 'GET') {
      const settings = await getGeneralSettings();
      return res.json({ ok: true, settings });
    }

    if (path === '/api/settings/general' && req.method === 'POST') {
      const actor = String(req.body?.actor || req.headers['x-user-email'] || 'crm').trim();
      const settings = await saveGeneralSettings(req.body || {}, actor);
      return res.json({ ok: true, settings });
    }

    if (path === '/api/whatsapp/send-from-crm' && req.method === 'POST') {
      const to = normalizePhone(req.body?.to);
      const text = String(req.body?.text || '').trim();
      const contactName = String(req.body?.contact_name || req.body?.name || 'Cliente').trim() || 'Cliente';
      if (!to) return res.status(400).json({ error: 'Falta destino.' });
      const sent = await sendSingleFromCRM({
        to,
        text,
        contactName,
        templateName: req.body?.template_name || req.body?.templateName || '',
        language: req.body?.language || req.body?.template_language || req.body?.templateLang || 'es_AR',
        variables: req.body?.variables || {},
      });
      return res.json({ ok: true, ...sent });
    }

    if (path === '/api/whatsapp/send-bulk-from-crm' && req.method === 'POST') {
      const rawItems = Array.isArray(req.body?.items) ? req.body.items : (Array.isArray(req.body?.recipients) ? req.body.recipients.map((r) => ({ ...r, to: r.to || r.phone || r.telefono, contact_name: r.contact_name || r.name || r.nombre, text: r.text || req.body?.text || '' })) : []);
      if (!rawItems.length) return res.status(400).json({ error: 'Faltan items para envío masivo.' });
      if (rawItems.length > 300) return res.status(400).json({ error: 'Máximo 300 envíos por lote.' });

      const defaultDelay = Number(req.body?.delay_ms ?? req.body?.delayMs ?? 700);
      const delayMs = Number.isFinite(defaultDelay) ? Math.max(0, Math.min(defaultDelay, 5000)) : 700;
      const results = [];
      let ok = 0;
      let errorCount = 0;
      let templateCount = 0;
      let textCount = 0;

      for (let i = 0; i < rawItems.length; i += 1) {
        const item = rawItems[i] || {};
        try {
          const sent = await sendSingleFromCRM({
            to: item.to,
            text: String(item.text || '').trim(),
            contactName: String(item.contact_name || item.name || 'Cliente').trim() || 'Cliente',
            templateName: item.template_name || item.templateName || req.body?.template_name || req.body?.templateName || '',
            language: item.language || item.template_language || item.templateLang || req.body?.language || req.body?.template_language || 'es_AR',
            variables: item.variables || {},
          });
          ok += 1;
          if (sent.mode === 'template') templateCount += 1;
          else textCount += 1;
          results.push({ index: i, ok: true, ...sent });
        } catch (error) {
          errorCount += 1;
          results.push({
            index: i,
            ok: false,
            to: normalizePhone(item.to),
            contact_name: String(item.contact_name || item.name || 'Cliente').trim() || 'Cliente',
            error: error.message || 'Error de envío',
            status: error.status || null,
            details: error.data || null,
          });
        }
        if (i < rawItems.length - 1 && delayMs > 0) await sleep(delayMs);
      }

      return res.json({
        ok: errorCount === 0,
        summary: {
          total: rawItems.length,
          ok,
          error: errorCount,
          text: textCount,
          template: templateCount,
          delay_ms: delayMs,
        },
        results,
      });
    }

    if (req.method === 'GET') {
      const mode = String(req.query['hub.mode'] || '');
      const token = String(req.query['hub.verify_token'] || '');
      const challenge = String(req.query['hub.challenge'] || '');

      if (mode === 'subscribe' && token && token === VERIFY_TOKEN) {
        logger.info('Webhook verificado correctamente con Meta');
        return res.status(200).send(challenge);
      }

      return res.status(403).send('Token incorrecto');
    }

    if (req.method !== 'POST') {
      return res.status(405).send('Método no permitido');
    }

    logger.info('Evento recibido de Meta', req.body);

    const incoming = parseIncomingMessages(req.body);
    const statuses = parseStatuses(req.body);

    for (const item of incoming) {
      const phone = item.wa_id;
      const name = item.contact_name || 'Cliente';
      const text = item.text || '';
      const assignment = await assignIncomingOwner(phone, text).catch(() => null);
      const msgRef = item.wa_message_id
        ? db.collection('mensajes').doc(item.wa_message_id)
        : db.collection('mensajes').doc();

      let storedMedia = item.media || null;
      if (storedMedia?.id) {
        try {
          storedMedia = await persistMediaToStorage({ messageId: item.wa_message_id || msgRef.id, media: storedMedia, direction: 'in' });
        } catch (mediaError) {
          logger.warn('No se pudo persistir media entrante', { messageId: item.wa_message_id || msgRef.id, error: mediaError.message });
        }
      }

      await msgRef.set(
        {
          telefono: phone,
          mensaje: text,
          origen: 'whatsapp',
          estado: 'nuevo',
          timestamp: admin.firestore.Timestamp.fromDate(new Date(item.at)),
          updatedAt: item.updatedAt,
          tipo: item.type,
          dir: 'in',
          wa_id: phone,
          wa_message_id: item.wa_message_id,
          at: item.at,
          contact_name: name,
          nombre_contacto: name,
          numero_crm: item.displayPhoneNumber,
          phone_number_id: item.phoneNumberId,
          media: storedMedia || null,
          ownerId: assignment?.ownerId || '',
          agentId: assignment?.agentId || assignment?.ownerId || '',
          responsable: assignment?.responsable || assignment?.ownerId || '',
          ownerName: assignment?.ownerName || '',
          ownerRole: assignment?.ownerRole || '',
          sector: assignment?.sector || '',
          raw: item.raw,
        },
        { merge: true }
      );

      await upsertContact(phone, name, item.at, { lastMessage: text, direction: 'entrante', ...assignment });
      await ensureEmbudo(phone, item.at, { lastMessage: text, direction: 'entrante', messageId: item.wa_message_id || msgRef.id, waMessageId: item.wa_message_id || msgRef.id, contactName: name, nombre_wsp: name, ...assignment });
      await saveHistorial(phone, name, text, item.at, assignment);
      await handleSalesBotInbound(item, assignment).catch((botError) => logger.warn("Bot ventas online no respondió", { phone, error: botError.message }));
    }

    if (statuses.length) {
      await saveStatuses(statuses);
    }

    if (!incoming.length && !statuses.length) {
      logger.info('Evento recibido sin mensajes ni estados para guardar');
    } else {
      logger.info(`Sincronización OK: mensajes=${incoming.length} estados=${statuses.length}`);
    }

    return res.status(200).send('EVENT_RECEIVED');
  } catch (error) {
    logger.error('Error en alherWebhook', error);
    if (error.graph_endpoint || error.meta_code || error.meta_type) {
      return res.status(error.status || 500).json(sanitizeGraphErrorForClient(error));
    }
    return res.status(error.status || 500).json({ error: error.message || 'Error interno', details: error.data || null });
  }
});
