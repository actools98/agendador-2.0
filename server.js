import express from 'express';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN = process.env.ADMIN_PASSWORD;
const PORT = process.env.PORT || 3000;
// Profesionales: PROFESSIONALS="Pepito Pérez:clave1:correo@ej.com,Sultanito:clave2,Yajaira:clave3"
// (nombre:contraseña:correo — el correo es opcional). El orden fija la identidad (p1, p2, p3): no lo cambies.
// MAX_PROFESSIONALS (por defecto 3) es el límite del contrato. ENABLE_SERVICES=true activa los servicios (proyecto salón).
const MAX_PROS = Number(process.env.MAX_PROFESSIONALS) || 3;
const SERVICES_ON = String(process.env.ENABLE_SERVICES || '').toLowerCase() === 'true';
const rawPros = (process.env.PROFESSIONALS || '').split(',').map(x => x.trim()).filter(Boolean);
if (rawPros.length > MAX_PROS) console.warn(`PROFESSIONALS tiene ${rawPros.length} profesionales; solo se usan los primeros ${MAX_PROS} (MAX_PROFESSIONALS).`);
const PROS = rawPros.slice(0, MAX_PROS).map((x, i) => { const [name = '', pass = '', mail = ''] = x.split(':').map(t => t.trim()); return { id: 'p' + (i + 1), name, pass, mail }; }).filter(p => p.name);
const seenPass = new Set([ADMIN]);
for (const p of PROS) { if (p.pass && seenPass.has(p.pass)) { console.warn(`La contraseña de ${p.name} está repetida o es igual a la del administrador: ese usuario no podrá entrar.`); p.pass = ''; } if (p.pass) seenPass.add(p.pass); }
const proIds = PROS.length ? PROS.map(p => p.id) : ['p1'];
const proOf = id => PROS.find(p => p.id === id);
if (!ADMIN) { console.error('Falta la variable ADMIN_PASSWORD'); process.exit(1); }

fs.mkdirSync(DATA, { recursive: true });
const DB_FILE = path.join(DATA, 'agenda.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS weeks(wk TEXT PRIMARY KEY, cfg TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bookings(
    id TEXT PRIMARY KEY, date TEXT NOT NULL, time TEXT NOT NULL,
    name TEXT NOT NULL, phone TEXT NOT NULL,
    created TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(date, time));
  CREATE TABLE IF NOT EXISTS services(
    id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL DEFAULT 0,
    dur INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, pos INTEGER NOT NULL DEFAULT 0);
`);
const hasCol = c => db.prepare('PRAGMA table_info(bookings)').all().some(x => x.name === c);
if (!hasCol('email')) db.exec('ALTER TABLE bookings ADD COLUMN email TEXT');
if (!hasCol('service')) db.exec('ALTER TABLE bookings ADD COLUMN service TEXT');

// Migración v2: citas con duración variable, precio guardado y estado (se quita UNIQUE(date,time)).
// Antes de tocar nada se guarda una copia del archivo (agenda.db.antes-v2.bak).
if (db.pragma('user_version', { simple: true }) < 2) {
  db.pragma('wal_checkpoint(TRUNCATE)');
  try { fs.copyFileSync(DB_FILE, DB_FILE + '.antes-v2.bak'); } catch (e) { console.warn('No se pudo copiar la base de datos:', e.message); }
  const oldDur = Number(db.prepare("SELECT v FROM settings WHERE k='dur'").get()?.v) || 45;
  db.transaction(() => {
    db.exec(`CREATE TABLE bookings2(
      id TEXT PRIMARY KEY, date TEXT NOT NULL, time TEXT NOT NULL, name TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '', email TEXT DEFAULT '', service TEXT DEFAULT '',
      service_id TEXT, price INTEGER NOT NULL DEFAULT 0, dur INTEGER, tip INTEGER,
      status TEXT NOT NULL DEFAULT 'activa', created TEXT DEFAULT CURRENT_TIMESTAMP)`);
    db.prepare(`INSERT INTO bookings2(id,date,time,name,phone,email,service,dur,created)
      SELECT id,date,time,name,phone,COALESCE(email,''),COALESCE(service,''),?,created FROM bookings`).run(oldDur);
    db.exec('DROP TABLE bookings; ALTER TABLE bookings2 RENAME TO bookings; CREATE INDEX IF NOT EXISTS idx_bk_date ON bookings(date)');
    db.pragma('user_version = 2');
  })();
}

// Migración v3: cada profesional tiene su propio horario y sus propias citas (todo lo existente pasa a p1).
if (db.pragma('user_version', { simple: true }) < 3) {
  db.pragma('wal_checkpoint(TRUNCATE)');
  try { fs.copyFileSync(DB_FILE, DB_FILE + '.antes-v3.bak'); } catch (e) { console.warn('No se pudo copiar la base de datos:', e.message); }
  db.transaction(() => {
    if (!hasCol('pro')) db.exec("ALTER TABLE bookings ADD COLUMN pro TEXT NOT NULL DEFAULT 'p1'");
    db.exec(`CREATE TABLE weeks2(pro TEXT NOT NULL DEFAULT 'p1', wk TEXT NOT NULL, cfg TEXT NOT NULL, PRIMARY KEY(pro, wk));
      INSERT INTO weeks2(pro,wk,cfg) SELECT 'p1',wk,cfg FROM weeks;
      DROP TABLE weeks; ALTER TABLE weeks2 RENAME TO weeks;
      CREATE INDEX IF NOT EXISTS idx_bk_pro ON bookings(pro, date)`);
    db.pragma('user_version = 3');
  })();
}

/* ---- correo (SMTP) ---- */
const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM } = process.env;
const BUSINESS = process.env.BUSINESS_NAME || 'Agenda de citas';
// Teléfono del negocio que se muestra en los correos (BUSINESS_PHONE, ej. "300 123 4567")
const PHONE = (process.env.BUSINESS_PHONE || '').trim();
const phoneDigits = PHONE.replace(/\D/g, '');
const waLink = phoneDigits ? `https://wa.me/${phoneDigits.length === 10 ? '57' + phoneDigits : phoneDigits}` : '';
const AUTO = 'Este correo fue enviado automáticamente. Por favor, no respondas a este mensaje.';
const port = Number(SMTP_PORT) || 465;
const mailer = SMTP_HOST ? nodemailer.createTransport({
  host: SMTP_HOST, port, secure: port === 465,
  auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 10000
}) : null;
if (!mailer) console.warn('SMTP_HOST no configurado: no se enviarán correos de confirmación');
const DIAS = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// ---------- Correos (diseño con tablas e estilos en línea, para que se vea igual en Gmail, Outlook, etc.) ----------
const ACCENT = '#2f6f5e';
const waNum = p => { const d = String(p).replace(/\D/g, ''); return d.length === 10 ? '57' + d : d; };
const money = n => '$' + Number(n || 0).toLocaleString('es-CO');
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);
const cuandoDe = b => { const d = new Date(b.date + 'T00:00:00Z'); return { dia: `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`, hora: b.time }; };
const fila = (ic, label, val) => `<tr><td style="padding:12px 0;border-bottom:1px solid #eef0f2;width:34px;font-size:20px;vertical-align:top">${ic}</td><td style="padding:12px 0;border-bottom:1px solid #eef0f2;vertical-align:top"><div style="font-size:11px;color:#8a919a;text-transform:uppercase;letter-spacing:.8px">${label}</div><div style="font-size:16px;color:#1f2328;font-weight:600;margin-top:2px">${val}</div></td></tr>`;
const boton = (href, txt) => `<a href="${href}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 24px;border-radius:10px">${txt}</a>`;
const shell = (sub, head, body, foot) => `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f3f4f6"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:16px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2328"><tr><td style="background:${ACCENT};padding:30px 24px;text-align:center"><div style="font-size:12px;color:#cfe6df;letter-spacing:1.2px;text-transform:uppercase">${sub}</div><div style="font-size:26px;font-weight:700;color:#ffffff;margin-top:8px">${head}</div></td></tr><tr><td style="padding:26px 24px">${body}</td></tr><tr><td style="padding:16px 24px 22px;background:#fafafa;text-align:center;font-size:12px;color:#8a919a;border-top:1px solid #eef0f2">${foot}</td></tr></table></td></tr></table></body></html>`;
const marca = () => `${ICON ? ICON + ' ' : ''}${esc(BUSINESS)}`;

async function sendConfirmation(b) {
  if (!mailer) return false;
  const { dia, hora } = cuandoDe(b), addr = getAddress();
  const aviso = addr ? `Te esperamos en ${addr}. Recuerda llegar 10 minutos antes.` : 'Recuerda llegar 10 minutos antes.';
  const body = `<p style="font-size:16px;line-height:1.5;margin:0 0 18px">Hola <b>${esc(b.name)}</b>, tu cita quedó agendada. Estos son los detalles:</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${fila('📅', 'Fecha', esc(cap(dia)))}${fila('🕐', 'Hora', esc(hora))}${b.pro ? fila('🧑', 'Profesional', esc(b.pro)) : ''}${fila(ICON || '💼', 'Servicio', esc(b.service) + (b.catalog ? ` <span style="font-weight:400;color:#8a919a">· ${b.dur} min</span>` : ''))}${b.price > 0 ? fila('💵', 'Valor', esc(money(b.price))) : ''}</table>
<p style="font-size:15px;line-height:1.5;margin:22px 0 0;padding:14px 16px;background:#e8f3ef;border-radius:10px;color:#1f4d41">⏰ ${esc(aviso)}</p>
${addr ? `<div style="text-align:center;margin-top:22px">${boton('https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(addr), '📍 Ver en el mapa')}</div>` : ''}
<p style="font-size:14px;line-height:1.6;color:#6b7280;margin:22px 0 0;text-align:center">Si no puedes asistir, avísanos con tiempo.${PHONE ? `<br>¿Dudas? Comunícate al <a href="${waLink}" style="color:${ACCENT};font-weight:600">${esc(PHONE)}</a>` : ''}</p>`;
  try {
    await mailer.sendMail({
      from: MAIL_FROM || SMTP_USER, to: b.email,
      subject: `Cita confirmada: ${dia} a las ${hora}`,
      text: `¡Cita confirmada!\n\nHola ${b.name}, tu cita quedó agendada.\nFecha: ${cap(dia)}\nHora: ${hora}${b.pro ? `\nProfesional: ${b.pro}` : ''}\nServicio: ${b.service}${b.catalog ? ` (${b.dur} min)` : ''}${b.price > 0 ? `\nValor: ${money(b.price)}` : ''}${addr ? `\nLugar: ${addr}` : ''}\n\n${aviso}\nSi no puedes asistir, avísanos con tiempo.${PHONE ? `\n¿Dudas? Comunícate al ${PHONE}` : ''}\n\n${BUSINESS}\n${AUTO}`,
      html: shell(marca(), '¡Cita confirmada! ✅', body, esc(AUTO))
    });
    return true;
  } catch (e) { console.error('Falló el envío de correo:', e.message); return false; }
}

// Aviso al profesional cuando alguien reserva (NOTIFY_EMAIL, o el mismo buzón SMTP_USER)
async function notifyOwner(b) {
  const to = [...new Set([b.proMail, process.env.NOTIFY_EMAIL || SMTP_USER].filter(Boolean))].join(', ');
  if (!mailer || !to) return;
  const { dia, hora } = cuandoDe(b);
  const body = `<p style="font-size:16px;line-height:1.5;margin:0 0 18px"><b>${esc(b.name)}</b> acaba de agendar una cita.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${fila('📅', 'Fecha', esc(cap(dia)))}${fila('🕐', 'Hora', esc(hora))}${b.pro ? fila('🧑', 'Profesional', esc(b.pro)) : ''}${fila(ICON || '💼', 'Servicio', esc(b.service) + (b.catalog ? ` <span style="font-weight:400;color:#8a919a">· ${b.dur} min</span>` : ''))}${b.price > 0 ? fila('💵', 'Valor', esc(money(b.price))) : ''}${fila('📱', 'Celular', `<a href="https://wa.me/${waNum(b.phone)}" style="color:${ACCENT}">${esc(b.phone)}</a>`)}${fila('✉️', 'Correo', `<a href="mailto:${esc(b.email)}" style="color:${ACCENT}">${esc(b.email)}</a>`)}</table>
<div style="text-align:center;margin-top:24px">${boton('https://wa.me/' + waNum(b.phone), '💬 Escribirle por WhatsApp')}</div>`;
  try {
    await mailer.sendMail({
      from: MAIL_FROM || SMTP_USER, to,
      subject: `Nueva cita: ${b.name} - ${dia} a las ${hora}`,
      text: `Nueva cita\n${cap(dia)} a las ${hora}${b.pro ? `\nProfesional: ${b.pro}` : ''}\nCliente: ${b.name}\nServicio: ${b.service}${b.price > 0 ? ` - ${money(b.price)}` : ''}\nCelular: ${b.phone}\nCorreo: ${b.email}`,
      html: shell(marca(), 'Nueva cita 🗓️', body, 'Aviso automático de tu agenda de citas.')
    });
  } catch (e) { console.error('Falló el aviso al profesional:', e.message); }
}

/* ---- fechas (Colombia = UTC-5, sin horario de verano) ---- */
const toIso = d => d.toISOString().slice(0, 10);
const D = s => new Date(s + 'T00:00:00Z');
const addD = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return toIso(d); };
const monday = s => addD(s, -((D(s).getUTCDay() + 6) % 7));
const nowCO = () => new Date(Date.now() - 5 * 3600e3);
const tm = s => { const [a, b] = s.split(':').map(Number); return a * 60 + b; };
const hm = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

const getAddress = () => db.prepare("SELECT v FROM settings WHERE k='address'").get()?.v || '';
const getDur = (pro = 'p1') => Number(db.prepare('SELECT v FROM settings WHERE k=?').get('dur:' + pro)?.v) || Number(db.prepare("SELECT v FROM settings WHERE k='dur'").get()?.v) || 45;
function weekCfg(pro, wk) {
  const q = db.prepare('SELECT cfg FROM weeks WHERE pro=? AND wk=?');
  for (let i = 0; i <= 12; i++) { const r = q.get(pro, addD(wk, -7 * i)); if (r) return JSON.parse(r.cfg); }
  const d = {}; for (let i = 0; i < 7; i++) d[i] = { on: i >= 1 && i <= 5, f: '09:00', t: '18:00' };
  return { d, br: { on: false, f: '13:00', t: '14:00' } };
}
const STEP = 30;                       // las citas empiezan cada 30 minutos
const TIME = /^\d{2}:\d{2}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const getBuffer = () => { const r = db.prepare("SELECT v FROM settings WHERE k='buffer'").get(); return r ? Number(r.v) : 10; };
const activeServices = () => !SERVICES_ON ? [] : db.prepare('SELECT id,name,price,dur FROM services WHERE active=1 ORDER BY pos, rowid').all();

// Horas de inicio posibles para una cita de `dur` minutos ese día.
// - all=true incluye horas ya pasadas (el administrador puede registrar a alguien que ya llegó)
// - Sin servicios creados funciona como antes: duración fija y sin pausa.
// - Con servicios, entre una cita y la siguiente queda la pausa configurada (los bloqueos no la llevan).
function starts(date, dur, { pro = 'p1', all = false, step = STEP, newBuf } = {}) {
  const cfg = weekCfg(pro, monday(date)), c = cfg.d[D(date).getUTCDay()], br = cfg.br?.on ? cfg.br : null;
  if (!c || !c.on) return [];
  const n = nowCO(), today = toIso(n), nowM = n.getUTCHours() * 60 + n.getUTCMinutes();
  if (!all && date < today) return [];
  const B = activeServices().length ? getBuffer() : 0, nb = newBuf ?? B;
  const busy = db.prepare("SELECT time,dur,service_id FROM bookings WHERE date=? AND pro=? AND status!='cancelada'").all(date, pro)
    .map(b => ({ s: tm(b.time), e: tm(b.time) + (b.dur || getDur(pro)) + (b.service_id === 'block' ? 0 : B) }));
  const out = [];
  for (let m = tm(c.f); m + dur <= tm(c.t); m += step) {
    if (br && m < tm(br.t) && m + dur > tm(br.f)) continue;         // cae en el descanso
    if (!all && date === today && m <= nowM) continue;               // ya pasó
    if (busy.some(x => m < x.e && m + dur + nb > x.s)) continue;     // choca con otra cita
    out.push(hm(m));
  }
  return out;
}

/* ---- app ---- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (t) {
    if (same(t, ADMIN)) { req.user = { role: 'admin' }; return next(); }
    const p = PROS.find(x => x.pass && same(t, x.pass));
    if (p) { req.user = { role: 'pro', pro: p.id }; return next(); }
  }
  res.status(401).json({ error: 'No autorizado' });
};
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Solo el administrador puede hacer esto' });
const svcOn = (req, res, next) => SERVICES_ON ? next() : res.status(404).json({ error: 'Los servicios no están activados' });
// Profesional sobre el que actúa la petición: el profesional siempre ve solo el suyo; el administrador elige con ?pro=
const scope = req => req.user.role === 'pro' ? req.user.pro : (proIds.includes(req.query.pro) ? req.query.pro : proIds[0]);
const hits = new Map(); // límite simple: 10 reservas por IP por hora
const limit = (req, res, next) => {
  const k = req.ip, now = Date.now(), arr = (hits.get(k) || []).filter(t => now - t < 3600e3);
  if (arr.length >= 10) return res.status(429).json({ error: 'Demasiados intentos, prueba más tarde' });
  arr.push(now); hits.set(k, arr); next();
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Público: nombre del negocio e icono del servicio
// SERVICE_ICON: un emoji. Sin definir = ✂️. Escribe "none" (o deja el valor vacío) para no mostrar ningún icono.
const rawIcon = (process.env.SERVICE_ICON ?? '✂️').trim();
const ICON = ['none', 'ninguno', '-'].includes(rawIcon.toLowerCase()) ? '' : rawIcon;
app.get('/api/config', (_, res) => res.json({
  name: process.env.BUSINESS_NAME || '', icon: ICON, services: activeServices(),
  pros: PROS.map(p => ({ id: p.id, name: p.name }))
}));

// Profesional elegido en una petición pública (si solo hay uno, no hace falta elegir)
const publicPro = v => (proIds.length === 1 ? proIds[0] : (proIds.includes(v) ? v : null));

// Público: horas libres de un profesional (14 días: esta semana y la siguiente)
app.get('/api/public', (req, res) => {
  const pro = publicPro(req.query.pro);
  if (!pro) return res.status(400).json({ error: 'Elige un profesional' });
  const svcs = activeServices();
  let dur, step = STEP;
  if (svcs.length) {
    const s = svcs.find(x => x.id === req.query.service);
    if (!s) return res.status(400).json({ error: 'Elige un servicio' });
    dur = s.dur;
  } else { dur = getDur(pro); step = dur; }
  const wk = monday(DATE.test(req.query.week) ? req.query.week : toIso(nowCO()));
  const days = {};
  for (let i = 0; i < 14; i++) { const d = addD(wk, i); days[d] = starts(d, dur, { pro, step }); }
  res.json({ week: wk, days });
});

// Público: reservar
app.post('/api/book', limit, async (req, res) => {
  const { date, time, name, phone, email, service, service_id } = req.body || {};
  const pro = publicPro(req.body?.pro);
  if (!pro) return res.status(400).json({ error: 'Elige un profesional' });
  const em = String(email || '').trim().toLowerCase().slice(0, 120);
  const n = String(name || '').trim().slice(0, 60), p = String(phone || '').replace(/[^\d+]/g, '').slice(0, 20);
  if (!DATE.test(date) || !TIME.test(time) || n.length < 2 || p.length < 7 || !EMAIL.test(em))
    return res.status(400).json({ error: 'Datos inválidos' });
  const svcs = activeServices();
  let s = null, dur, step = STEP, sname, price = 0;
  if (svcs.length) {
    s = svcs.find(x => x.id === service_id);
    if (!s) return res.status(400).json({ error: 'Elige un servicio' });
    dur = s.dur; sname = s.name; price = s.price;
  } else {
    sname = String(service || '').trim().slice(0, 100);
    if (sname.length < 2) return res.status(400).json({ error: 'Datos inválidos' });
    dur = getDur(pro); step = dur;
  }
  // comprobar e insertar sin ningún "await" en medio: así dos reservas simultáneas no se pisan
  if (!starts(date, dur, { pro, step }).includes(time)) return res.status(409).json({ error: 'Esa hora ya no está disponible' });
  db.prepare('INSERT INTO bookings(id,date,time,name,phone,email,service,service_id,price,dur,pro) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), date, time, n, p, em, sname, s ? s.id : null, price, dur, pro);
  const multi = PROS.length > 1, who = proOf(pro);
  const info = { date, time, name: n, email: em, phone: p, service: sname, price, dur, catalog: !!s, pro: multi ? who.name : '' };
  notifyOwner({ ...info, proMail: who?.mail || '' });
  const mailed = await sendConfirmation(info);
  res.json({ ok: true, ...info, mailed });
});

// ---- Admin / profesionales ----
app.get('/api/admin/state', auth, (req, res) => {
  const pro = scope(req), weeks = {};
  for (const r of db.prepare('SELECT wk,cfg FROM weeks WHERE pro=?').all(pro)) weeks[r.wk] = JSON.parse(r.cfg);
  res.json({
    role: req.user.role, pros: PROS.map(p => ({ id: p.id, name: p.name })), pro, proName: proOf(pro)?.name || '',
    servicesOn: SERVICES_ON, dur: getDur(pro), buffer: getBuffer(), address: getAddress(), services: activeServices(), weeks,
    bookings: db.prepare("SELECT id,date,time,name,phone,email,service,service_id,price,dur,status FROM bookings WHERE pro=? AND status!='cancelada' ORDER BY date,time").all(pro)
  });
});
app.put('/api/admin/week/:wk', auth, (req, res) => {
  const wk = req.params.wk, cfg = req.body, pro = scope(req);
  if (!DATE.test(wk) || monday(wk) !== wk || !cfg?.d) return res.status(400).json({ error: 'Semana inválida' });
  const b = cfg.br;
  const br = b && TIME.test(b.f) && TIME.test(b.t) ? { on: !!b.on, f: b.f, t: b.t } : { on: false, f: '13:00', t: '14:00' };
  db.prepare('INSERT INTO weeks(pro,wk,cfg) VALUES(?,?,?) ON CONFLICT(pro,wk) DO UPDATE SET cfg=excluded.cfg').run(pro, wk, JSON.stringify({ d: cfg.d, br }));
  res.json({ ok: true });
});
const setSetting = (k, v) => db.prepare('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v));
// La dirección y la pausa son del negocio: solo el administrador las cambia
app.put('/api/admin/address', auth, adminOnly, (req, res) => {
  setSetting('address', String(req.body?.address ?? '').trim().slice(0, 200));
  res.json({ ok: true });
});
app.put('/api/admin/dur', auth, (req, res) => {
  const v = Number(req.body?.dur);
  if (![15, 20, 30, 45, 60, 90, 120].includes(v)) return res.status(400).json({ error: 'Duración inválida' });
  setSetting('dur:' + scope(req), v);
  res.json({ ok: true });
});
app.put('/api/admin/buffer', auth, adminOnly, svcOn, (req, res) => {
  const v = Number(req.body?.buffer);
  if (![0, 5, 10, 15, 20, 30].includes(v)) return res.status(400).json({ error: 'Pausa inválida' });
  setSetting('buffer', v);
  res.json({ ok: true });
});

// Servicios (proyecto salón; solo con ENABLE_SERVICES=true). Quitar = archivar.
const svcBody = b => {
  const name = String(b?.name || '').trim().slice(0, 60), price = Math.round(Number(b?.price ?? 0)), dur = Math.round(Number(b?.dur));
  if (name.length < 2 || !Number.isFinite(price) || price < 0 || price > 10000000 || !Number.isFinite(dur) || dur < 10 || dur > 480) return null;
  return { name, price, dur };
};
app.post('/api/admin/service', auth, adminOnly, svcOn, (req, res) => {
  const v = svcBody(req.body);
  if (!v) return res.status(400).json({ error: 'Datos del servicio inválidos' });
  if (activeServices().length >= 30) return res.status(400).json({ error: 'Máximo 30 servicios' });
  const pos = db.prepare('SELECT COALESCE(MAX(pos),0)+1 AS p FROM services').get().p;
  db.prepare('INSERT INTO services(id,name,price,dur,pos) VALUES(?,?,?,?,?)').run(crypto.randomUUID().slice(0, 8), v.name, v.price, v.dur, pos);
  res.json({ ok: true });
});
app.put('/api/admin/service/:id', auth, adminOnly, svcOn, (req, res) => {
  const v = svcBody(req.body);
  if (!v) return res.status(400).json({ error: 'Datos del servicio inválidos' });
  db.prepare('UPDATE services SET name=?, price=?, dur=? WHERE id=? AND active=1').run(v.name, v.price, v.dur, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/admin/service/:id', auth, adminOnly, svcOn, (req, res) => {
  db.prepare('UPDATE services SET active=0 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Horas libres de un día para el profesional elegido y qué servicios caben en cada una
app.get('/api/admin/free', auth, (req, res) => {
  const date = req.query.date, pro = scope(req);
  if (!DATE.test(date)) return res.status(400).json({ error: 'Fecha inválida' });
  const svcs = activeServices(), rows = new Map();
  const row = t => { if (!rows.has(t)) rows.set(t, { t, svc: [], block: false }); return rows.get(t); };
  if (svcs.length) {
    for (const s of svcs) for (const t of starts(date, s.dur, { pro, all: true })) row(t).svc.push(s.id);
    for (const t of starts(date, STEP, { pro, all: true, newBuf: 0 })) row(t).block = true;
  } else {
    const d = getDur(pro);
    for (const t of starts(date, d, { pro, all: true, step: d })) { row(t).svc.push('-'); row(t).block = true; }
  }
  res.json({ rows: [...rows.values()].sort((a, b) => (a.t < b.t ? -1 : 1)) });
});

// Agendar a mano (clientes de WhatsApp o sin cita) o bloquear una hora
app.post('/api/admin/booking', auth, (req, res) => {
  const { date, time, name, phone, service, service_id, block } = req.body || {};
  const pro = scope(req);
  if (!DATE.test(date) || !TIME.test(time)) return res.status(400).json({ error: 'Datos inválidos' });
  const svcs = activeServices();
  let n, dur, step = STEP, sname = '', sid = null, price = 0, newBuf;
  if (block) { n = '⛔ Bloqueado'; sid = 'block'; newBuf = 0; dur = svcs.length ? STEP : getDur(pro); if (!svcs.length) step = dur; }
  else {
    n = String(name || '').trim().slice(0, 60);
    if (n.length < 2) return res.status(400).json({ error: 'Escribe el nombre del cliente' });
    if (svcs.length) {
      const s = svcs.find(x => x.id === service_id);
      if (!s) return res.status(400).json({ error: 'Elige un servicio' });
      dur = s.dur; sname = s.name; sid = s.id; price = s.price;
    } else { dur = getDur(pro); step = dur; sname = String(service || '').trim().slice(0, 100); }
  }
  if (!starts(date, dur, { pro, all: true, step, newBuf }).includes(time)) return res.status(409).json({ error: 'Ese servicio no cabe en ese horario' });
  db.prepare('INSERT INTO bookings(id,date,time,name,phone,email,service,service_id,price,dur,pro) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), date, time, n, block ? '' : String(phone || '').replace(/[^\d+]/g, '').slice(0, 20), '', sname, sid, price, dur, pro);
  res.json({ ok: true });
});
// Cancelar = marcar como cancelada (queda el historial). Los bloqueos sí se borran.
app.delete('/api/admin/booking/:id', auth, (req, res) => {
  const b = db.prepare('SELECT service_id, pro FROM bookings WHERE id=?').get(req.params.id);
  if (b && (req.user.role === 'admin' || b.pro === req.user.pro)) {
    if (b.service_id === 'block') db.prepare('DELETE FROM bookings WHERE id=?').run(req.params.id);
    else db.prepare("UPDATE bookings SET status='cancelada' WHERE id=?").run(req.params.id);
  }
  res.json({ ok: true });
});

app.get('/health', (_, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log('Agendador en puerto ' + PORT + (PROS.length ? ` (${PROS.length} profesionales: ${PROS.map(p => p.name).join(', ')})` : '')));
