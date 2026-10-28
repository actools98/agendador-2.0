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
if (!ADMIN) { console.error('Falta la variable ADMIN_PASSWORD'); process.exit(1); }

fs.mkdirSync(DATA, { recursive: true });
const db = new Database(path.join(DATA, 'agenda.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT);
  CREATE TABLE IF NOT EXISTS weeks(wk TEXT PRIMARY KEY, cfg TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS bookings(
    id TEXT PRIMARY KEY, date TEXT NOT NULL, time TEXT NOT NULL,
    name TEXT NOT NULL, phone TEXT NOT NULL,
    created TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(date, time));
`);

if (!db.prepare('PRAGMA table_info(bookings)').all().some(c => c.name === 'email'))
  db.exec('ALTER TABLE bookings ADD COLUMN email TEXT');
if (!db.prepare('PRAGMA table_info(bookings)').all().some(c => c.name === 'service'))
  db.exec('ALTER TABLE bookings ADD COLUMN service TEXT');

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
async function sendConfirmation(b) {
  if (!mailer) return false;
  const d = new Date(b.date + 'T00:00:00Z');
  const cuando = `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} a las ${b.time}`;
  try {
    await mailer.sendMail({
      from: MAIL_FROM || SMTP_USER, to: b.email,
      subject: `Cita confirmada: ${cuando}`,
      text: `Hola ${b.name}, tu cita quedó confirmada para el ${cuando}.\nServicio: ${b.service}\n\nSi no puedes asistir, avísanos con tiempo.\n\n${BUSINESS}${PHONE ? `\n¿Dudas? Comunícate al ${PHONE}` : ''}\n\n${AUTO}`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px"><h2>¡Cita confirmada!</h2><p>Hola ${esc(b.name)}, te esperamos el <b>${esc(cuando)}</b>.</p><p>Servicio: <b>${esc(b.service)}</b></p><p style="color:#666">Si no puedes asistir, avísanos con tiempo.</p><p style="margin:16px 0 0"><b>${esc(BUSINESS)}</b>${PHONE ? `<br>¿Dudas? Comunícate al <a href="${waLink}">${esc(PHONE)}</a>` : ''}</p><p style="color:#888;font-size:12px;margin-top:16px">${AUTO}</p></div>`
    });
    return true;
  } catch (e) { console.error('Falló el envío de correo:', e.message); return false; }
}

// Aviso al profesional cuando alguien reserva (NOTIFY_EMAIL, o el mismo buzón SMTP_USER)
async function notifyOwner(b) {
  const to = process.env.NOTIFY_EMAIL || SMTP_USER;
  if (!mailer || !to) return;
  const d = new Date(b.date + 'T00:00:00Z');
  const cuando = `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]} a las ${b.time}`;
  try {
    await mailer.sendMail({
      from: MAIL_FROM || SMTP_USER, to,
      subject: `Nueva cita: ${b.name} - ${cuando}`,
      text: `Nueva cita\n${cuando}\nCliente: ${b.name}\nServicio: ${b.service}\nCelular: ${b.phone}\nCorreo: ${b.email}`,
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px"><h2>Nueva cita</h2><p><b>${esc(cuando)}</b></p><p>Cliente: <b>${esc(b.name)}</b><br>Servicio: ${esc(b.service)}<br>Celular: <a href="https://wa.me/57${esc(String(b.phone).replace(/\D/g, ''))}">${esc(b.phone)}</a><br>Correo: ${esc(b.email)}</p></div>`
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

const getDur = () => Number(db.prepare("SELECT v FROM settings WHERE k='dur'").get()?.v) || 45;
function weekCfg(wk) {
  const q = db.prepare('SELECT cfg FROM weeks WHERE wk=?');
  for (let i = 0; i <= 12; i++) { const r = q.get(addD(wk, -7 * i)); if (r) return JSON.parse(r.cfg); }
  const d = {}; for (let i = 0; i < 7; i++) d[i] = { on: i >= 1 && i <= 5, f: '09:00', t: '18:00' };
  return { d, br: { on: false, f: '13:00', t: '14:00' } };
}
// all=true: incluye horas ya pasadas (el administrador puede registrar a alguien que ya llegó)
function slotsFor(date, all = false) {
  const cfg = weekCfg(monday(date)), c = cfg.d[D(date).getUTCDay()], br = cfg.br?.on ? cfg.br : null;
  if (!c || !c.on) return [];
  const n = nowCO(), today = toIso(n), nowM = n.getUTCHours() * 60 + n.getUTCMinutes(), dur = getDur(), out = [];
  if (!all && date < today) return [];
  for (let m = tm(c.f); m + dur <= tm(c.t); m += dur) {
    if (br && m < tm(br.t) && m + dur > tm(br.f)) continue; // cae en el descanso
    if (!all && date === today && m <= nowM) continue;
    out.push(hm(m));
  }
  return out;
}

/* ---- app ---- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));

const auth = (req, res, next) => {
  const a = Buffer.from((req.headers.authorization || '').replace('Bearer ', '')), b = Buffer.from(ADMIN);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'No autorizado' });
};
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
app.get('/api/config', (_, res) => res.json({ name: process.env.BUSINESS_NAME || '', icon: ICON }));

// Público: horas libres de una semana (sin datos de otros clientes)
app.get('/api/public', (req, res) => {
  const wk = monday(DATE.test(req.query.week) ? req.query.week : toIso(nowCO()));
  const taken = db.prepare('SELECT date,time FROM bookings WHERE date BETWEEN ? AND ?').all(wk, addD(wk, 13));
  const days = {};
  for (let i = 0; i < 14; i++) { // esta semana y la siguiente
    const d = addD(wk, i);
    days[d] = slotsFor(d).filter(t => !taken.some(x => x.date === d && x.time === t));
  }
  res.json({ week: wk, dur: getDur(), days });
});

// Público: reservar
app.post('/api/book', limit, async (req, res) => {
  const { date, time, name, phone, email, service } = req.body || {};
  const sv = String(service || '').trim().slice(0, 100);
  const em = String(email || '').trim().toLowerCase().slice(0, 120);
  const n = String(name || '').trim().slice(0, 60), p = String(phone || '').replace(/[^\d+]/g, '').slice(0, 20);
  if (!DATE.test(date) || !/^\d{2}:\d{2}$/.test(time) || n.length < 2 || sv.length < 2 || p.length < 7 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em))
    return res.status(400).json({ error: 'Datos inválidos' });
  if (!slotsFor(date).includes(time)) return res.status(409).json({ error: 'Esa hora ya no está disponible' });
  try {
    db.prepare('INSERT INTO bookings(id,date,time,name,phone,email,service) VALUES(?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), date, time, n, p, em, sv);
  } catch { return res.status(409).json({ error: 'Esa hora acaba de ser tomada' }); }
  notifyOwner({ date, time, name: n, email: em, service: sv, phone: p });
  const mailed = await sendConfirmation({ date, time, name: n, email: em, service: sv });
  res.json({ ok: true, date, time, name: n, email: em, service: sv, mailed });
});

// Admin
app.get('/api/admin/state', auth, (req, res) => {
  const weeks = {}; for (const r of db.prepare('SELECT wk,cfg FROM weeks').all()) weeks[r.wk] = JSON.parse(r.cfg);
  res.json({ dur: getDur(), weeks, bookings: db.prepare('SELECT id,date,time,name,phone,email,service FROM bookings ORDER BY date,time').all() });
});
app.put('/api/admin/week/:wk', auth, (req, res) => {
  const wk = req.params.wk, cfg = req.body;
  if (!DATE.test(wk) || monday(wk) !== wk || !cfg?.d) return res.status(400).json({ error: 'Semana inválida' });
  const T = /^\d{2}:\d{2}$/, b = cfg.br;
  const br = b && T.test(b.f) && T.test(b.t) ? { on: !!b.on, f: b.f, t: b.t } : { on: false, f: '13:00', t: '14:00' };
  db.prepare('INSERT INTO weeks(wk,cfg) VALUES(?,?) ON CONFLICT(wk) DO UPDATE SET cfg=excluded.cfg').run(wk, JSON.stringify({ d: cfg.d, br }));
  res.json({ ok: true });
});
app.put('/api/admin/dur', auth, (req, res) => {
  const v = Number(req.body?.dur);
  if (![15, 20, 30, 45, 60, 90, 120].includes(v)) return res.status(400).json({ error: 'Duración inválida' });
  db.prepare("INSERT INTO settings(k,v) VALUES('dur',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(v));
  res.json({ ok: true });
});
// Admin: agendar a mano (clientes de WhatsApp o sin cita) o bloquear una hora
app.post('/api/admin/booking', auth, (req, res) => {
  const { date, time, name, service, phone, block } = req.body || {};
  const n = block ? '⛔ Bloqueado' : String(name || '').trim().slice(0, 60);
  if (!DATE.test(date) || !/^\d{2}:\d{2}$/.test(time) || n.length < 2) return res.status(400).json({ error: 'Datos inválidos' });
  if (!slotsFor(date, true).includes(time)) return res.status(409).json({ error: 'Esa hora no está en tu horario' });
  try {
    db.prepare('INSERT INTO bookings(id,date,time,name,phone,email,service) VALUES(?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), date, time, n, block ? '' : String(phone || '').replace(/[^\d+]/g, '').slice(0, 20), '', block ? '' : String(service || '').trim().slice(0, 100));
  } catch { return res.status(409).json({ error: 'Esa hora ya está ocupada' }); }
  res.json({ ok: true });
});
app.delete('/api/admin/booking/:id', auth, (req, res) => {
  db.prepare('DELETE FROM bookings WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/health', (_, res) => res.send('ok'));
app.use(express.static(path.join(__dirname, 'public')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log('Agendador en puerto ' + PORT));
