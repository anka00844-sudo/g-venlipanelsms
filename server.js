const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const APP_VERSION = '2026-10-09-FULL-PACKAGE-V1';

// ====== AYARLAR (Render > Environment veya doğrudan buraya) ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const ADMIN_TELEGRAM_USERNAME = process.env.ADMIN_TELEGRAM_USERNAME || 'vipankaa';
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '573181006792';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://g-venlipanelsms.onrender.com';
const ONAYLI_SMS_API_KEY = process.env.ONAYLI_SMS_API_KEY || 'osms_7f193a3fe65448a9380061c1b56e9fdc29f49c67e89eb3dd';
const ONAYLI_SMS_URL = 'https://onaylasms.com.tr/stubs/handler_api.php';
const LOW_BALANCE_THRESHOLD = parseFloat(process.env.LOW_BALANCE_THRESHOLD || '50');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Aklomanti';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AZC.anka.34';

// ====== SAĞLAYICI KUYRUĞU (TOO_MANY_REQUESTS Önleyici) ======
const PROVIDER_MIN_INTERVAL_MS = 2200;
let providerQueue = Promise.resolve();
let lastProviderCallAt = 0;
function providerGet(params, timeout) {
    const run = providerQueue.then(async () => {
        const wait = PROVIDER_MIN_INTERVAL_MS - (Date.now() - lastProviderCallAt);
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        lastProviderCallAt = Date.now();
        return axios.get(ONAYLI_SMS_URL, { params: Object.assign({ api_key: ONAYLI_SMS_API_KEY }, params), timeout: timeout || 20000 });
    });
    providerQueue = run.then(() => {}, () => {});
    return run;
}

const DEFAULT_DB = {
    users: {
        [ADMIN_USERNAME]: { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, balance: 5000, role: "admin", status: "approved", banned: false }
    },
    payments: {},
    visitors: [],
    logins: [],
    orders: {},
    support: {}
};

// ====== KALICI VERİTABANI ======
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'anka_data.json');
let db = DEFAULT_DB;
try {
    if (fs.existsSync(DB_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = Object.assign({}, DEFAULT_DB, loaded);
        for (const k in DEFAULT_DB) if (db[k] === undefined) db[k] = DEFAULT_DB[k];
        if (!db.users || !Object.keys(db.users).length) db.users = DEFAULT_DB.users;
        for (const u in DEFAULT_DB.users) {
            if (!db.users[u]) db.users[u] = DEFAULT_DB.users[u];
        }
    }
} catch (e) { console.error('[db] Disk yükleme hatası:', e.message); }

db.users[ADMIN_USERNAME] = Object.assign(
    { balance: 5000 },
    db.users[ADMIN_USERNAME] || {},
    { username: ADMIN_USERNAME, password: ADMIN_PASSWORD, role: 'admin', status: 'approved', banned: false }
);

let saveTimer = null;
function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('[db] Diske yazma hatası:', e.message); }
    }, 400);
}

let supportMsgMap = {};

function guessSource(req) {
    const q = (req.query && (req.query.src || req.query.utm_source || req.query.ref) || '').toLowerCase();
    if (q) {
        if (q.includes('telegram') || q === 'tg') return 'Telegram';
        if (q.includes('whatsapp') || q === 'wa') return 'WhatsApp';
        if (q.includes('facebook') || q === 'fb') return 'Facebook';
        if (q.includes('instagram') || q === 'ig') return 'Instagram';
        return q.charAt(0).toUpperCase() + q.slice(1);
    }
    const ref = (req.headers['referer'] || req.headers['referrer'] || '').toLowerCase();
    if (!ref) return 'Direkt / Bilinmiyor';
    if (ref.includes('facebook.com') || ref.includes('fb.com')) return 'Facebook';
    if (ref.includes('t.me') || ref.includes('telegram.org')) return 'Telegram';
    if (ref.includes('wa.me') || ref.includes('whatsapp.com')) return 'WhatsApp';
    if (ref.includes('instagram.com')) return 'Instagram';
    if (ref.includes('tiktok.com')) return 'TikTok';
    if (ref.includes('google.')) return 'Google';
    if (ref.includes('twitter.com') || ref.includes('x.com')) return 'Twitter/X';
    if (ref.includes(RENDER_EXTERNAL_URL.replace(/^https?:\/\//, ''))) return 'Direkt / Bilinmiyor';
    try { return new URL(req.headers['referer']).hostname; } catch (e) { return 'Direkt / Bilinmiyor'; }
}

app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!db.visitors.some(v => v.ip === ip)) {
        db.visitors.unshift({ ip, time: new Date().toLocaleString('tr-TR'), source: guessSource(req), path: req.path });
        if (db.visitors.length > 150) db.visitors.pop();
    }
    next();
});

// ====== ADMIN OTURUM TOKENLARI ======
let adminSessions = {};
function createAdminSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions[token] = { username, ts: Date.now() };
    return token;
}

function checkAdminToken(token) {
    const sess = token && adminSessions[token];
    if (!sess) return null;
    if (Date.now() - sess.ts > 24 * 60 * 60 * 1000) { delete adminSessions[token]; return null; }
    if (!db.users[sess.username] || db.users[sess.username].role !== 'admin') return null;
    return sess.username;
}

// ====== ÜRÜN KATALOĞU ======
const CATALOG = [
    { id: 'wa_tr', key: 'tr', name: 'WhatsApp Türkiye', serviceCode: 'wa', defCountry: '62', price: 300, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-emerald-500/10', color: 'text-emerald-400' },
    { id: 'wa_tr_dinlenmis', key: 'tr', name: 'Dinlendirilmiş WhatsApp Türkiye', serviceCode: 'wa', defCountry: '62', price: 360, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-emerald-500/10', color: 'text-emerald-400' },
    { id: 'tg_tr', key: 'tr', name: 'Telegram Türkiye', serviceCode: 'tg', defCountry: '62', price: 200, icon: 'fa-telegram', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-400' },
    { id: 'wa_ph', key: 'ph', name: 'WhatsApp Filipinler', serviceCode: 'wa', defCountry: '4', price: 200, icon: 'fa-whatsapp', iconSet: 'fa-brands', bg: 'bg-emerald-500/10', color: 'text-emerald-400' },
    { id: 'tg_us', key: 'us', name: 'Telegram ABD', serviceCode: 'tg', defCountry: '187', alt: ['12'], price: 200, icon: 'fa-telegram', iconSet: 'fa-brands', bg: 'bg-blue-500/10', color: 'text-blue-400' },
    { id: 'ig_tr', key: 'tr', name: 'Instagram Türkiye', defCountry: '62', price: 60, serviceHints: ['instagram'], guessCodes: ['ig'], icon: 'fa-instagram', iconSet: 'fa-brands', bg: 'bg-pink-500/10', color: 'text-pink-400' },
    { id: 'go_tr', key: 'tr', name: 'Google / Gmail Türkiye', defCountry: '62', price: 60, serviceHints: ['google', 'gmail'], guessCodes: ['go'], icon: 'fa-google', iconSet: 'fa-brands', bg: 'bg-red-500/10', color: 'text-red-400' },
    { id: 'ds_tr', key: 'tr', name: 'Discord Türkiye', defCountry: '62', price: 60, serviceHints: ['discord'], guessCodes: ['ds', 'dc'], icon: 'fa-discord', iconSet: 'fa-brands', bg: 'bg-indigo-500/10', color: 'text-indigo-400' }
];

const SERVICE_INFO = {
    wa: { name: 'WhatsApp', icon: 'fa-whatsapp', bg: 'bg-emerald-500/10', color: 'text-emerald-400' },
    tg: { name: 'Telegram', icon: 'fa-telegram', bg: 'bg-blue-500/10', color: 'text-blue-400' }
};

let servicesListCache = { time: 0, byCode: {} };
async function resolveServicesList() {
    if (servicesListCache.time && Date.now() - servicesListCache.time < 3600000) return servicesListCache;
    const byCode = {};
    try {
        const r = await providerGet({ action: 'getServicesList' }, 15000);
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        let arr = [];
        if (Array.isArray(d)) arr = d;
        else if (d && Array.isArray(d.services)) arr = d.services;
        else if (d && typeof d === 'object') arr = Object.keys(d).map(k => ({ code: k, name: (d[k] && typeof d[k] === 'object') ? (d[k].name || d[k].title || d[k].eng) : d[k] }));
        for (const s of arr) {
            if (!s) continue;
            const code = s.code !== undefined ? s.code : (s.id !== undefined ? s.id : s.key);
            const name = s.name || s.title || s.eng || s.rus;
            if (code !== undefined && name) byCode[String(code)] = String(name);
        }
    } catch (e) { console.error('[resolveServicesList] hata:', e.message); }
    servicesListCache = { time: Date.now(), byCode };
    return servicesListCache;
}

let serviceOverrides = {};
let serviceCodeCache = {};
async function resolveServiceCode(item) {
    if (item.serviceCode) return item.serviceCode;
    if (serviceOverrides[item.id]) return serviceOverrides[item.id];
    const cached = serviceCodeCache[item.id];
    if (cached && Date.now() - cached.time < 3600000) return cached.code;
    const { byCode } = await resolveServicesList();
    const hints = (item.serviceHints || []).map(normTr);
    let found = null;
    for (const code in byCode) {
        const n = normTr(byCode[code]);
        if (hints.some(h => n.includes(h))) { found = code; break; }
    }
    const code = found || (item.guessCodes && item.guessCodes[0]) || item.id;
    serviceCodeCache[item.id] = { code, time: Date.now(), confirmed: !!found };
    return code;
}

function normTr(s) {
    return String(s).toLowerCase()
        .replace(/ı/g, 'i').replace(/İ/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
        .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c').trim();
}

function nameHas(key, n) {
    const t = normTr(n);
    if (key === 'tr') return t.includes('turkey') || t.includes('turkiye') || t.includes('турци') || /^tr$/.test(t) || t === 'turkiye cumhuriyeti';
    if (key === 'ph') return t.includes('philippines') || t.includes('филиппин') || t.includes('filipin');
    if (key === 'us') return /\busa\b/.test(t) || t.includes('united states') || t.includes('сша') || t.includes('amerika birlesik');
    return false;
}

let countryCache = { time: 0, map: {}, all: {} };
async function resolveCountries() {
    if (countryCache.time && Date.now() - countryCache.time < 3600000) return countryCache;
    const map = {};
    const all = { tr: [], ph: [], us: [] };
    try {
        const r = await providerGet({ action: 'getCountries' }, 15000);
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        if (d && typeof d === 'object') {
            const arr = Array.isArray(d) ? d : Object.keys(d).map(k => Object.assign({ _k: k }, typeof d[k] === 'object' ? d[k] : { name: d[k] }));
            for (const c of arr) {
                if (!c || typeof c !== 'object') continue;
                const id = c.id !== undefined ? String(c.id) : (c._k !== undefined ? String(c._k) : null);
                if (id === null) continue;
                const names = Object.values(c).filter(v => typeof v === 'string' || typeof v === 'number').map(x => String(x).toLowerCase().trim());
                for (const key in all) {
                    if (names.some(n => nameHas(key, n))) { if (!map[key]) map[key] = id; if (!all[key].includes(id)) all[key].push(id); }
                }
            }
        }
    } catch (e) { console.error('[resolveCountries] hata:', e.message); }
    countryCache = { time: Date.now(), map, all };
    return countryCache;
}

let priceCache = {};
async function fetchServicePrices(serviceCode) {
    const cached = priceCache[serviceCode];
    if (cached && Date.now() - cached.time < 45000) return cached.data;
    const out = {};
    try {
        const r = await providerGet({ action: 'getPrices', service: serviceCode }, 15000);
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        if (d && typeof d === 'object') {
            if (d[serviceCode] && typeof d[serviceCode] === 'object') {
                for (const cid in d[serviceCode]) {
                    const svc = d[serviceCode][cid];
                    if (svc && typeof svc === 'object') {
                        const cost = svc.cost !== undefined ? svc.cost : (svc.price !== undefined ? svc.price : 0);
                        const count = svc.count !== undefined ? svc.count : (svc.quant !== undefined ? svc.quant : (svc.quantity !== undefined ? svc.quantity : 0));
                        out[cid] = { cost: Number(cost) || 0, count: Number(count) || 0 };
                    }
                }
            }
            if (Object.keys(out).length === 0) {
                for (const cid in d) {
                    const v = d[cid];
                    if (!v || typeof v !== 'object') continue;
                    const svc = (v[serviceCode] !== undefined) ? v[serviceCode] : v;
                    if (svc && typeof svc === 'object') {
                        const cost = svc.cost !== undefined ? svc.cost : (svc.price !== undefined ? svc.price : 0);
                        const count = svc.count !== undefined ? svc.count : (svc.quant !== undefined ? svc.quant : (svc.quantity !== undefined ? svc.quantity : 0));
                        if (cost || count) out[cid] = { cost: Number(cost) || 0, count: Number(count) || 0 };
                    }
                }
            }
        }
    } catch (e) { console.error('[fetchServicePrices] hata:', e.message); }
    priceCache[serviceCode] = { time: Date.now(), data: out };
    return out;
}

async function countryCandidates(item, serviceCode) {
    const { map, all } = await resolveCountries();
    const nameList = [];
    const primary = map[item.key] || item.defCountry;
    nameList.push(primary);
    (all[item.key] || []).forEach(id => { if (!nameList.includes(id)) nameList.push(id); });
    (item.alt || []).forEach(id => { if (!nameList.includes(id)) nameList.push(id); });
    if (!nameList.includes(item.defCountry)) nameList.push(item.defCountry);

    const prices = await fetchServicePrices(serviceCode || item.serviceCode);
    const withStock = nameList.filter(id => prices[id] && prices[id].count > 0)
        .sort((a, b) => (prices[b].count - prices[a].count));
    const withoutInfo = nameList.filter(id => !prices[id]);
    const noStock = nameList.filter(id => prices[id] && prices[id].count === 0);
    const ordered = [...withStock, ...withoutInfo, ...noStock];
    return ordered.length ? ordered : nameList;
}

// ====== SERVİS API ======
app.get('/api/getServices', (req, res) => {
    const list = CATALOG.map(item => {
        const meta = (item.icon ? item : SERVICE_INFO[item.serviceCode]) || {};
        return { id: item.id, name: item.name, price: item.price, icon: meta.icon || 'fa-circle', iconSet: meta.iconSet || 'fa-solid', bg: meta.bg || 'bg-emerald-500/10', color: meta.color || 'text-emerald-400' };
    });
    res.json({ success: true, services: list });
});

app.get('/api/getCustomerBalance', (req, res) => {
    const { username } = req.query;
    if (db.users[username]) {
        res.json({ success: true, balance: db.users[username].balance, role: db.users[username].role });
    } else {
        res.json({ success: false, message: "Kullanıcı bulunamadı." });
    }
});

// ====== KULLANICI GİRİŞİ (ONAY KONTROLLÜ) ======
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const user = db.users[username];

    if (user && user.password === password) {
        if (user.banned) return res.json({ success: false, message: "Hesabınız yasaklandı." });
        if (user.status === 'pending') return res.json({ success: false, message: "Üyeliğiniz henüz admin tarafından onaylanmadı." });
        if (user.status === 'rejected') return res.json({ success: false, message: "Üyelik talebiniz reddedildi." });

        const visitorRec = db.visitors.find(v => v.ip === ip);
        const source = (visitorRec && visitorRec.source) || 'Bilinmiyor';
        db.logins.unshift({ username, ip, source, time: new Date().toLocaleString('tr-TR'), ts: Date.now() });
        if (db.logins.length > 300) db.logins.length = 300;

        const adminToken = user.role === 'admin' ? createAdminSession(username) : null;
        res.json({ success: true, username, role: user.role, adminToken });
    } else {
        res.json({ success: false, message: "Hatalı kullanıcı adı veya şifre!" });
    }
});

// ====== TELEGRAM BİLDİRİMLİ VE YÖNETİCİ ONAYLI KAYIT ======
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: "Alanlar boş bırakılamaz." });
    if (db.users[username]) return res.json({ success: false, message: "Bu kullanıcı adı zaten alınmış." });

    db.users[username] = {
        username,
        password,
        balance: 0,
        role: "user",
        status: "pending",
        banned: false,
        createdAt: Date.now(),
        registeredAt: new Date().toLocaleString('tr-TR')
    };
    persist();

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `🚨 **YENİ ÜYELİK TALEBİ!**\n\n👤 Kullanıcı Adı: ${username}\n📅 Tarih: ${db.users[username].registeredAt}\n\nKullanıcı panelinize kayıt olmak istiyor.`,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ Kaydı Onayla", callback_data: `user_approve|${username}` },
                    { text: "❌ Reddet", callback_data: `user_reject|${username}` }
                ]]
            }
        });
    } catch (e) { console.error('[Telegram] Bildirim hatası:', e.message); }

    res.json({ success: true, message: "Kayıt talebiniz alındı. Admin onayladıktan sonra giriş yapabilirsiniz." });
});

// ====== TELEGRAM BOT WEBHOOK ======
app.post('/telegram/webhook', (req, res) => {
    const update = req.body;
    if (update && update.callback_query) {
        const query = update.callback_query;
        const [action, payload] = (query.data || '').split('|');

        if (action === 'user_approve' && db.users[payload]) {
            db.users[payload].status = 'approved';
            persist();
            axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: query.id, text: `${payload} onaylandı.` });
            axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `✅ **ONAYLANDI**\n\nKullanıcı Adı: ${payload}` });
        } else if (action === 'user_reject' && db.users[payload]) {
            db.users[payload].status = 'rejected';
            persist();
            axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: query.id, text: `${payload} reddedildi.` });
            axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `❌ **REDDEDİLDİ**\n\nKullanıcı Adı: ${payload}` });
        }
    }
    res.sendStatus(200);
});

app.post('/api/deposit/notify', async (req, res) => {
    const { username, senderName, amount } = req.body;
    if (!username || !senderName || !amount) return res.json({ success: false, message: "Tüm alanları doldurun." });

    const paymentId = 'pay_' + Date.now();
    db.payments[paymentId] = { id: paymentId, username, senderName, amount: parseFloat(amount), status: 'pending', time: new Date().toLocaleString('tr-TR'), ts: Date.now() };
    persist();

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `💰 Yeni Ödeme Bildirimi!\n\nKullanıcı: ${username}\nGönderen: ${senderName}\nTutar: ${amount} TL`,
            reply_markup: { inline_keyboard: [[{ text: "✅ Onayla", callback_data: `approve|${paymentId}` }, { text: "❌ Reddet", callback_data: `reject|${paymentId}` }]] }
        });
    } catch (e) {}

    res.json({ success: true, message: "Ödeme bildiriminiz alındı. İnceleniyor." });
});

// ====== KORUMALI ADMIN ENDPOINTLERİ ======
app.get('/api/admin/getData', (req, res) => {
    const { adminToken } = req.query;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz erişim." });

    const users = Object.values(db.users).map(u => ({ username: u.username, balance: u.balance, role: u.role, status: u.status || 'approved', registeredAt: u.registeredAt || '-' }));
    res.json({
        success: true,
        users,
        payments: Object.values(db.payments).sort((a, b) => (b.ts || 0) - (a.ts || 0)),
        logins: db.logins.slice(0, 100),
        orders: Object.values(db.orders).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100),
        visitors: db.visitors.length
    });
});

app.post('/api/admin/processPayment', (req, res) => {
    const { adminToken, paymentId, action } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });

    const payment = db.payments[paymentId];
    if (!payment || payment.status !== 'pending') return res.json({ success: false, message: "Ödeme bulunamadı." });

    if (action === 'approve') {
        payment.status = 'approved';
        if (db.users[payment.username]) db.users[payment.username].balance += payment.amount;
        persist();
        res.json({ success: true, message: "Ödeme onaylandı." });
    } else {
        payment.status = 'rejected';
        persist();
        res.json({ success: true, message: "Ödeme reddedildi." });
    }
});

app.post('/api/admin/adjustBalance', (req, res) => {
    const { adminToken, username, amount } = req.body;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    if (!username || !db.users[username]) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
    const amt = Number(amount);
    if (isNaN(amt) || amt === 0) return res.json({ success: false, message: "Geçerli bir tutar girin." });
    db.users[username].balance += amt;
    if (db.users[username].balance < 0) db.users[username].balance = 0;
    persist();
    res.json({ success: true, message: username + " kullanıcısının bakiyesi güncellendi.", newBalance: db.users[username].balance });
});

// ====== ANA SAYFA ARAYÜZÜ (Cannot GET / Çözümü) ======
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="tr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SMS Onay Paneli</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-slate-900 text-white min-h-screen flex items-center justify-center p-4">
        <div class="bg-slate-800 p-8 rounded-xl shadow-2xl max-w-md w-full border border-slate-700">
            <h1 class="text-2xl font-bold text-center text-blue-400 mb-6">SMS Onay Paneli</h1>
            
            <div id="msg" class="hidden p-3 mb-4 rounded text-sm text-center"></div>

            <!-- Giriş Formu -->
            <div id="loginForm">
                <h2 class="text-lg font-semibold mb-4 text-slate-300">Giriş Yap</h2>
                <input id="l_user" type="text" placeholder="Kullanıcı Adı" class="w-full mb-3 p-3 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-blue-500">
                <input id="l_pass" type="password" placeholder="Şifre" class="w-full mb-4 p-3 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-blue-500">
                <button onclick="login()" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded transition">Giriş Yap</button>
                <p class="mt-4 text-sm text-center text-slate-400">Hesabın yok mu? <a href="#" onclick="toggleForm()" class="text-blue-400 underline">Kayıt Ol</a></p>
            </div>

            <!-- Kayıt Formu -->
            <div id="registerForm" class="hidden">
                <h2 class="text-lg font-semibold mb-4 text-slate-300">Kayıt Ol (Yönetici Onaylı)</h2>
                <input id="r_user" type="text" placeholder="Kullanıcı Adı" class="w-full mb-3 p-3 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-emerald-500">
                <input id="r_pass" type="password" placeholder="Şifre" class="w-full mb-4 p-3 rounded bg-slate-700 border border-slate-600 focus:outline-none focus:border-emerald-500">
                <button onclick="register()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded transition">Kayıt Talebi Gönder</button>
                <p class="mt-4 text-sm text-center text-slate-400">Zaten üye misin? <a href="#" onclick="toggleForm()" class="text-blue-400 underline">Giriş Yap</a></p>
            </div>
        </div>

        <script>
            function toggleForm() {
                document.getElementById('loginForm').classList.toggle('hidden');
                document.getElementById('registerForm').classList.toggle('hidden');
            }

            function showMsg(txt, success) {
                const el = document.getElementById('msg');
                el.innerText = txt;
                el.className = 'p-3 mb-4 rounded text-sm text-center ' + (success ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30');
                el.classList.remove('hidden');
            }

            async function login() {
                const username = document.getElementById('l_user').value;
                const password = document.getElementById('l_pass').value;
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if(data.success) {
                    showMsg("Giriş başarılı! Rol: " + data.role, true);
                    if(data.role === 'admin') alert("Admin Girişi Yapıldı! Token: " + data.adminToken);
                } else {
                    showMsg(data.message, false);
                }
            }

            async function register() {
                const username = document.getElementById('r_user').value;
                const password = document.getElementById('r_pass').value;

                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                showMsg(data.message, data.success);
            }
        </script>
    </body>
    </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Sunucu Başlatıldı: Port ${PORT} [SURUM: ${APP_VERSION}]`);
});
