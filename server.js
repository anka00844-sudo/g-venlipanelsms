const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ====== AYARLAR (Render > Environment bölümünden girilecek) ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://yenipanel.onrender.com';
const ONAYLI_SMS_API_KEY = process.env.ONAYLI_SMS_API_KEY || 'osms_7f193a3fe65448a9380061c1b56e9fdc29f49c67e89eb3dd';
const ONAYLI_SMS_URL = 'https://onaylasms.com.tr/stubs/handler_api.php';
// Sağlayıcı fiyatını TL'ye çevirmek / kâr eklemek için çarpan (örn: 1.5 = %50 fazlası)
const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '1');
// Normal fiyatta numara yoksa, sağlayıcıdan satış fiyatının bu oranına kadar daha pahalı numara alınabilir
const MAX_COST_FACTOR = parseFloat(process.env.MAX_COST_FACTOR || '0.8');
const LOW_BALANCE_THRESHOLD = parseFloat(process.env.LOW_BALANCE_THRESHOLD || '50');

let db = {
    users: {
        "Aklomanti": { username: "Aklomanti", password: "Aklomanti", balance: 5000, role: "admin" }
    },
    payments: {},
    visitors: [],
    logins: [],
    orders: {},
    support: {} // username -> [{from:'user'|'admin', text, time, ts}]
};
let supportMsgMap = {}; // telegram mesaj id -> username (adminin hangi mesaja cevap verdiğini bulmak için)

app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!db.visitors.some(v => v.ip === ip)) {
        db.visitors.unshift({ ip, time: new Date().toLocaleString('tr-TR') });
        if (db.visitors.length > 50) db.visitors.pop();
    }
    next();
});

// ====== SAĞLAYICI YARDIMCILARI ======
const SERVICE_INFO = {
    wa: { name: 'WhatsApp', icon: 'fa-whatsapp', type: 'fa-brands', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
    tg: { name: 'Telegram', icon: 'fa-telegram', type: 'fa-brands', color: 'text-blue-400', bg: 'bg-blue-500/10' },
    go: { name: 'Google / Gmail', icon: 'fa-google', type: 'fa-brands', color: 'text-amber-400', bg: 'bg-amber-500/10' },
    ig: { name: 'Instagram', icon: 'fa-instagram', type: 'fa-brands', color: 'text-pink-400', bg: 'bg-pink-500/10' },
    fb: { name: 'Facebook', icon: 'fa-facebook', type: 'fa-brands', color: 'text-blue-500', bg: 'bg-blue-500/10' },
    tw: { name: 'Twitter / X', icon: 'fa-twitter', type: 'fa-brands', color: 'text-sky-400', bg: 'bg-sky-500/10' },
    ds: { name: 'Discord', icon: 'fa-discord', type: 'fa-brands', color: 'text-indigo-400', bg: 'bg-indigo-500/10' },
    lf: { name: 'TikTok', icon: 'fa-tiktok', type: 'fa-brands', color: 'text-pink-300', bg: 'bg-pink-500/10' }
};
const POPULAR = Object.keys(SERVICE_INFO);

const COUNTRY_NAMES = {
    '0': 'Rusya', '1': 'Ukrayna', '2': 'Kazakistan', '4': 'Filipinler', '6': 'Endonezya', '7': 'Malezya',
    '10': 'Vietnam', '12': 'ABD (Sanal)', '16': 'İngiltere', '22': 'Hindistan', '43': 'Almanya',
    '62': 'Türkiye', '73': 'Brezilya', '78': 'Fransa', '187': 'ABD'
};

// Sağlayıcıya her istekte gitmemek için kısa süreli önbellek (ban yememek için ŞART)
let pricesCache = { time: 0, data: null };

async function getProviderPrices(force = false) {
    if (!force && pricesCache.data && Date.now() - pricesCache.time < 15000) return pricesCache.data;

    const resp = await axios.get(ONAYLI_SMS_URL, {
        params: { api_key: ONAYLI_SMS_API_KEY, action: 'getPrices' },
        timeout: 20000
    });
    let d = resp.data;
    if (typeof d === 'string') {
        try { d = JSON.parse(d); }
        catch (e) { throw new Error('Sağlayıcı yanıtı: ' + d.slice(0, 120)); }
    }
    if (!d || typeof d !== 'object') throw new Error('Sağlayıcıdan geçersiz yanıt geldi.');

    pricesCache = { time: Date.now(), data: d };
    return d;
}

function calcPrice(cost) {
    return Math.round(parseFloat(cost) * PRICE_MULTIPLIER * 100) / 100;
}

function readInfo(info) {
    if (!info || typeof info !== 'object') return { count: 0, cost: 0 };
    const count = parseInt(info.count !== undefined ? info.count : (info.stock !== undefined ? info.stock : 0));
    const cost = parseFloat(info.cost !== undefined ? info.cost : (info.price !== undefined ? info.price : 0));
    return { count: isNaN(count) ? 0 : count, cost: isNaN(cost) ? 0 : cost };
}

// ====== SABİT ÜRÜN KATALOĞU (sadece bu 4 ürün satılır) ======
// defCountry: ülke ID'si bulunamazsa kullanılacak varsayılan. Gerçek ID sağlayıcıdan otomatik bulunur.
const CATALOG = [
    { id: 'wa_tr', key: 'tr', name: 'WhatsApp Türkiye',    serviceCode: 'wa', defCountry: '62',  price: 300 },
    { id: 'tg_tr', key: 'tr', name: 'Telegram Türkiye',    serviceCode: 'tg', defCountry: '62',  price: 200 },
    { id: 'wa_ph', key: 'ph', name: 'WhatsApp Filipinler', serviceCode: 'wa', defCountry: '4',   price: 200 },
    { id: 'tg_us', key: 'us', name: 'Telegram ABD',        serviceCode: 'tg', defCountry: '187', alt: ['12'], price: 200 }
];
const COUNTRY_WANT = {
    tr: ['turkey', 'türkiye', 'turkiye', 'турция'],
    ph: ['philippines', 'filipinler', 'филиппины'],
    us: ['usa', 'united states', 'united states of america', 'abd', 'сша']
};

// Ülke ID'lerini sağlayıcıdan otomatik bul (getCountries). Bulamazsa varsayılanlar kullanılır.
let countryCache = { time: 0, map: {}, count: 0 };
async function resolveCountries() {
    if (countryCache.time && Date.now() - countryCache.time < 3600000) return countryCache.map;
    const map = {};
    let count = 0;
    try {
        const r = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getCountries' }, timeout: 15000 });
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        if (d && typeof d === 'object') {
            const arr = Array.isArray(d) ? d : Object.keys(d).map(k => Object.assign({ _k: k }, typeof d[k] === 'object' ? d[k] : { name: d[k] }));
            count = arr.length;
            for (const c of arr) {
                if (!c || typeof c !== 'object') continue;
                const id = c.id !== undefined ? String(c.id) : (c._k !== undefined ? String(c._k) : null);
                if (id === null) continue;
                const names = [c.eng, c.rus, c.name, c.title, c.tr, c.country].filter(Boolean).map(x => String(x).toLowerCase().trim());
                for (const key in COUNTRY_WANT) {
                    if (!map[key] && names.some(n => COUNTRY_WANT[key].includes(n))) map[key] = id;
                }
            }
        }
    } catch (e) {}
    countryCache = { time: Date.now(), map, count };
    return map;
}
async function countryOf(item) {
    const map = await resolveCountries();
    return map[item.key] || item.defCountry;
}

let stockCache = {}; // ülke -> { time, data }
let rawStatus = {};
let rawPrices = {};
let priceCache = {};
async function getCountryStatus(country) {
    const c = stockCache[country];
    if (c && Date.now() - c.time < 10000) return c.data;
    try {
        const resp = await axios.get(ONAYLI_SMS_URL, {
            params: { api_key: ONAYLI_SMS_API_KEY, action: 'getNumbersStatus', country: country },
            timeout: 15000
        });
        let d = resp.data;
        rawStatus[country] = (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400);
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        stockCache[country] = { time: Date.now(), data: d };
        return d;
    } catch (e) {
        rawStatus[country] = 'HATA: ' + e.message;
        return null;
    }
}
function stockFromStatus(status, code) {
    if (!status || typeof status !== 'object') return null;
    for (const k in status) {
        if (k === code || k.startsWith(code + '_')) {
            const v = parseInt(status[k]);
            if (!isNaN(v)) return v;
        }
    }
    return null;
}
async function getPricesFor(country, code) {
    const key = country + '_' + code;
    const c = priceCache[key];
    if (c && Date.now() - c.time < 10000) return c.data;
    let d = null;
    try {
        const resp = await axios.get(ONAYLI_SMS_URL, {
            params: { api_key: ONAYLI_SMS_API_KEY, action: 'getPrices', country: country, service: code },
            timeout: 15000
        });
        d = resp.data;
        rawPrices[key] = (typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 400);
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    } catch (e) {
        rawPrices[key] = 'HATA: ' + e.message;
    }
    priceCache[key] = { time: Date.now(), data: d };
    return d;
}
async function getStock(country, code) {
    const st = stockFromStatus(await getCountryStatus(country), code);
    if (st !== null) return st;
    const p = await getPricesFor(country, code);
    if (p && typeof p === 'object') {
        const a = p[country] && p[country][code];
        if (a) return readInfo(a).count;
        const b = p[code] && p[code][country];
        if (b) return readInfo(b).count;
    }
    return null;
}

// ====== SERVİS LİSTESİ ======
app.get('/api/getServices', async (req, res) => {
    const q = (req.query.q || '').toString().toLowerCase().trim();
    const list = [];
    for (const item of CATALOG) {
        if (q && !item.name.toLowerCase().includes(q)) continue;
        const meta = SERVICE_INFO[item.serviceCode];
        list.push({
            id: item.id,
            name: item.name,
            price: item.price,
            serviceCode: item.serviceCode,
            icon: meta.icon, iconType: meta.type, color: meta.color, bg: meta.bg
        });
    }
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

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (db.users[username] && db.users[username].password === password) {
        db.logins.unshift({ username, ip, time: new Date().toLocaleString('tr-TR'), ts: Date.now() });
        if (db.logins.length > 200) db.logins.length = 200;
        res.json({ success: true, username, role: db.users[username].role });
    } else {
        res.json({ success: false, message: "Hatalı kullanıcı adı veya şifre!" });
    }
});

app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: "Alanlar boş bırakılamaz." });
    if (db.users[username]) return res.json({ success: false, message: "Bu kullanıcı adı zaten alınmış." });

    db.users[username] = { username, password, balance: 0, role: "user" };
    res.json({ success: true, username, role: "user" });
});

app.post('/api/deposit/notify', async (req, res) => {
    const { username, senderName, amount } = req.body;
    if (!username || !senderName || !amount) return res.json({ success: false, message: "Tüm alanları doldurun." });

    const paymentId = 'pay_' + Date.now();
    db.payments[paymentId] = { id: paymentId, username, senderName, amount: parseFloat(amount), status: 'pending', time: new Date().toLocaleString('tr-TR') };

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `💰 Yeni Ödeme Bildirimi!\n\nKullanıcı: ${username}\nGönderen: ${senderName}\nTutar: ${amount} TL`,
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: "✅ Onayla", callback_data: `approve|${paymentId}` },
                        { text: "❌ Reddet", callback_data: `reject|${paymentId}` }
                    ]
                ]
            }
        });
    } catch (e) {}

    res.json({ success: true, message: "Ödeme bildiriminiz alındı. İnceleniyor." });
});

function isAdmin(name) {
    return db.users[name] && db.users[name].role === 'admin';
}

app.get('/api/admin/getData', (req, res) => {
    const { adminUsername } = req.query;
    if (!isAdmin(adminUsername)) {
        return res.status(403).json({ success: false, message: "Yetkisiz erişim." });
    }
    res.json({ success: true, visitors: db.visitors, logins: db.logins, users: db.users, payments: db.payments, orders: db.orders });
});

app.post('/api/admin/processPayment', (req, res) => {
    const { adminUsername, paymentId, action } = req.body;
    if (!isAdmin(adminUsername)) return res.json({ success: false, message: "Yetkisiz." });

    const payment = db.payments[paymentId];
    if (!payment || payment.status !== 'pending') return res.json({ success: false, message: "Ödeme bulunamadı." });

    if (action === 'approve') {
        payment.status = 'approved';
        if (db.users[payment.username]) db.users[payment.username].balance += payment.amount;
        res.json({ success: true, message: "Ödeme onaylandı." });
    } else {
        payment.status = 'rejected';
        res.json({ success: true, message: "Ödeme reddedildi." });
    }
});

// Sağlayıcı bağlantı testi: bakiye, bulunan ülke ID'leri ve stok yanıtları
app.get('/api/admin/testApi', async (req, res) => {
    if (!isAdmin(req.query.adminUsername)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    try {
        const balResp = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getBalance' }, timeout: 20000 });
        countryCache.time = 0;
        const map = await resolveCountries();
        const out = { success: true, providerBalance: balResp.data, getCountriesKayitSayisi: countryCache.count, bulunanUlkeIdleri: map, urunler: [] };
        for (const item of CATALOG) {
            const country = await countryOf(item);
            const status = await getCountryStatus(country);
            out.urunler.push({
                urun: item.name,
                kullanilanUlkeId: country,
                servis: item.serviceCode,
                stok: await getStock(country, item.serviceCode),
                ham_getNumbersStatus_metin: rawStatus[country] || null,
                ham_getPrices_metin: rawPrices[country + '_' + item.serviceCode] || null,
                ham_getNumbersStatus: status && typeof status === 'object' ? (function () { const o = {}; for (const k in status) { if (k === item.serviceCode || k.startsWith(item.serviceCode + '_')) o[k] = status[k]; } return Object.keys(o).length ? o : 'bu servis yanıtta yok (anahtar sayısı: ' + Object.keys(status).length + ')'; })() : status
            });
        }
        res.json(out);
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

let lastBalanceAlert = 0;
async function notifyLowProviderBalance(text) {
    if (Date.now() - lastBalanceAlert < 600000) return;
    lastBalanceAlert = Date.now();
    try {
        await axios.post('https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage', { chat_id: ADMIN_CHAT_ID, text: text });
    } catch (e) {}
}

// ====== NUMARA SATIN ALMA ======
const PROVIDER_ERRORS = {
    NO_NUMBERS: 'Bu servis için şu an numara kalmamış. Başka ülke/servis deneyin.',
    WRONG_MAX_PRICE: 'Sağlayıcıdaki en ucuz numara belirlenen maliyet sınırının üzerinde.',
    NO_BALANCE: 'Sağlayıcı hesabında bakiye yok (panel sahibi bakiye yüklemeli).',
    BAD_KEY: 'Sağlayıcı API anahtarı hatalı.',
    BAD_SERVICE: 'Servis kodu geçersiz.',
    WRONG_SERVICE: 'Servis kodu geçersiz.',
    BAD_COUNTRY: 'Ülke kodu geçersiz.',
    BANNED: 'Sağlayıcı API hesabı engellenmiş.',
    ERROR_SQL: 'Sağlayıcıda geçici hata, tekrar deneyin.'
};

app.post('/api/buyNumber', async (req, res) => {
    const { productId, username } = req.body;
    const userObj = db.users[username];
    if (!userObj) return res.json({ success: false, message: "Kullanıcı bulunamadı." });

    const item = CATALOG.find(c => c.id === productId);
    if (!item) return res.json({ success: false, message: "Geçersiz ürün." });

    const price = item.price; // fiyat sunucudan, müşteri değiştiremez
    if (userObj.balance < price) return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin." });

    const showDetail = userObj.role === 'admin';

    try {
        const main = await countryOf(item);
        const countries = [main].concat((item.alt || []).filter(c => c !== main));
        let responseText = '';
        let usedCountry = main;

        // Sağlayıcı bakiyesi (üst fiyat sınırı bakiyeyi aşarsa sağlayıcı NO_BALANCE döner)
        let providerBalance = null;
        try {
            const bResp = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getBalance' }, timeout: 15000 });
            const bm = String(bResp.data || '').match(/ACCESS_BALANCE:([0-9.]+)/);
            if (bm) providerBalance = parseFloat(bm[1]);
        } catch (e) {}

        outer:
        for (const country of countries) {
            usedCountry = country;
            // Sağlayıcı anlık "NO_NUMBERS" dönebiliyor; ülke başına 2 kez dene
            for (let attempt = 0; attempt < 2; attempt++) {
                const resp = await axios.get(ONAYLI_SMS_URL, {
                    params: { api_key: ONAYLI_SMS_API_KEY, action: 'getNumber', service: item.serviceCode, country: country },
                    timeout: 30000
                });
                responseText = resp.data;
                if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
                responseText = responseText ? String(responseText).trim() : '';
                console.log('[getNumber] ' + item.id + ' country=' + country + ' deneme=' + (attempt + 1) + ' -> "' + responseText + '"');

                if (responseText.startsWith('ACCESS_NUMBER')) break outer;
                if (responseText.startsWith('NO_NUMBERS')) {
                    if (attempt < 1) await new Promise(r => setTimeout(r, 1200));
                    continue;
                }
                break outer; // başka bir hata (bakiye, anahtar vb.) -> tekrar deneme
            }

            // Normal fiyat kademesinde numara yoksa daha yüksek kademeyi dene (maliyet sınırı: satış fiyatı x MAX_COST_FACTOR)
            let maxPrice = Math.floor(price * MAX_COST_FACTOR);
            if (providerBalance !== null) maxPrice = Math.min(maxPrice, Math.floor(providerBalance));
            if (maxPrice < 1) continue;
            const resp2 = await axios.get(ONAYLI_SMS_URL, {
                params: { api_key: ONAYLI_SMS_API_KEY, action: 'getNumber', service: item.serviceCode, country: country, freePrice: 'true', maxPrice: maxPrice },
                timeout: 30000
            });
            responseText = resp2.data;
            if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
            responseText = responseText ? String(responseText).trim() : '';
            console.log('[getNumber+freePrice] ' + item.id + ' country=' + country + ' maxPrice=' + maxPrice + ' -> "' + responseText + '"');
            if (responseText.startsWith('ACCESS_NUMBER')) break outer;
            if (!responseText.startsWith('NO_NUMBERS') && !responseText.startsWith('WRONG_MAX_PRICE')) break outer;
        }

        if (responseText.startsWith('ACCESS_NUMBER')) {
            const parts = responseText.split(':');
            const activationId = parts[1];
            const phoneNumber = parts.slice(2).join(':');

            userObj.balance -= price;

            const order = {
                activationId,
                productName: item.name,
                price,
                phoneNumber,
                code: "Bekleniyor...",
                status: 'waiting',
                username,
                createdAt: Date.now(),
                time: new Date().toLocaleString('tr-TR')
            };
            db.orders[activationId] = order;
            return res.json({ success: true, order });
        }

        const key = responseText.split(':')[0];
        if (key === 'NO_BALANCE') notifyLowProviderBalance('⚠️ OnaylaSMS bakiyen yetersiz! Müşteri numara alamadı (' + item.name + '). Sağlayıcı bakiyesi: ' + (providerBalance !== null ? providerBalance : '?'));
        let msg;
        if (showDetail) {
            msg = (PROVIDER_ERRORS[key] || ('Sağlayıcı yanıtı: ' + responseText)) + ' [yanıt: ' + responseText + (providerBalance !== null ? ', sağlayıcı bakiyesi: ' + providerBalance : '') + ', ülke ID: ' + usedCountry + ', servis: ' + item.serviceCode + ']';
        } else if (key === 'NO_NUMBERS') {
            msg = 'Bu ürün için şu an numara bulunamadı. Lütfen birkaç dakika sonra tekrar deneyin.';
        } else {
            msg = 'Şu an numara alınamıyor, lütfen daha sonra tekrar deneyin.';
        }
        return res.json({ success: false, message: msg });
    } catch (error) {
        console.error("API Bağlantı Hatası:", error.message);
        return res.json({ success: false, message: showDetail ? ("Sağlayıcı bağlantı hatası: " + error.message) : "Bağlantı hatası, lütfen tekrar deneyin." });
    }
});

// ====== SİPARİŞLERİM (sayfa yenilenince numaralar kaybolmasın) ======
app.get('/api/myOrders', (req, res) => {
    const { username } = req.query;
    if (!db.users[username]) return res.json({ success: false, orders: [] });
    const now = Date.now();
    const list = Object.values(db.orders)
        .filter(o => o.username === username && o.createdAt)
        .filter(o => (o.status === 'waiting' && now - o.createdAt < 600000) || (o.status === 'completed' && now - o.createdAt < 1800000))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(o => ({
            activationId: o.activationId,
            phoneNumber: o.phoneNumber,
            productName: o.productName,
            status: o.status,
            code: o.code,
            remaining: Math.max(1, Math.floor((600000 - (now - o.createdAt)) / 1000))
        }));
    res.json({ success: true, orders: list });
});

// ====== NUMARA İPTAL ======
app.post('/api/cancelNumber', async (req, res) => {
    const { activationId, username } = req.body;
    const order = db.orders[activationId];
    const userObj = db.users[username];

    if (!order || !userObj || order.username !== username) return res.json({ success: false, message: "Sipariş bulunamadı." });
    if (order.status !== 'waiting') return res.json({ success: false, message: "Bu sipariş iptal edilemez." });

    try {
        const resp = await axios.get(ONAYLI_SMS_URL, {
            params: { api_key: ONAYLI_SMS_API_KEY, action: 'setStatus', status: 8, id: activationId },
            timeout: 20000
        });
        const text = String(resp.data || '').trim();
        console.log(`[cancel] ${activationId} -> "${text}"`);

        if (text.startsWith('ACCESS_CANCEL')) {
            userObj.balance += order.price;
            order.status = 'cancelled';
            return res.json({ success: true, message: "Numara iptal edildi ve bakiye hesabınıza iade edildi." });
        }
        if (text.startsWith('EARLY_CANCEL_DENIED')) {
            return res.json({ success: false, message: "Numara aldıktan sonra ilk 2 dakika iptal edilemez. Biraz sonra tekrar deneyin." });
        }
        return res.json({ success: false, message: "İptal edilemedi. Sağlayıcı yanıtı: " + text });
    } catch (error) {
        return res.json({ success: false, message: "Sağlayıcı bağlantı hatası, iptal yapılamadı: " + error.message });
    }
});

// ====== SMS KOD SORGULAMA ======
app.get('/api/checkSms/:id', async (req, res) => {
    const activationId = req.params.id;
    const order = db.orders[activationId];
    if (!order || order.status !== 'waiting') return res.json({ success: false, message: "Sipariş aktif değil." });

    try {
        const resp = await axios.get(ONAYLI_SMS_URL, {
            params: { api_key: ONAYLI_SMS_API_KEY, action: 'getStatus', id: activationId },
            timeout: 20000
        });
        let responseText = resp.data;
        if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
        responseText = responseText ? String(responseText).trim() : '';

        if (responseText.startsWith('STATUS_OK')) {
            const code = responseText.split(':').slice(1).join(':');
            order.code = code;
            order.status = 'completed';
            return res.json({ success: true, status: 'completed', code, phoneNumber: order.phoneNumber });
        }
        return res.json({ success: true, status: 'waiting', code: "Bekleniyor...", phoneNumber: order.phoneNumber });
    } catch (error) {
        return res.json({ success: true, status: 'waiting', code: "Bekleniyor...", phoneNumber: order.phoneNumber });
    }
});

// ====== CANLI DESTEK ======
app.post('/api/support/send', async (req, res) => {
    const { username, text } = req.body;
    if (!db.users[username] || !text || !text.trim()) return res.json({ success: false });
    if (!db.support[username]) db.support[username] = [];
    const msg = { from: 'user', text: text.trim().slice(0, 1000), time: new Date().toLocaleString('tr-TR'), ts: Date.now() };
    db.support[username].push(msg);
    if (db.support[username].length > 200) db.support[username].shift();

    try {
        const sent = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `💬 Destek | ${username}:\n${msg.text}`
        });
        const tgId = sent.data && sent.data.result && sent.data.result.message_id;
        if (tgId) supportMsgMap[tgId] = username;
    } catch (e) {}

    res.json({ success: true });
});

app.get('/api/support/messages', (req, res) => {
    const { username, sinceTs } = req.query;
    if (!db.users[username]) return res.json({ success: false, messages: [] });
    let list = db.support[username] || [];
    if (sinceTs) list = list.filter(m => m.ts > parseInt(sinceTs));
    res.json({ success: true, messages: list });
});

// Admin tüm açık destek sohbetlerini görsün
app.get('/api/admin/support', (req, res) => {
    if (!isAdmin(req.query.adminUsername)) return res.status(403).json({ success: false });
    const out = {};
    for (const u in db.support) {
        const arr = db.support[u];
        if (arr && arr.length) out[u] = arr[arr.length - 1];
    }
    res.json({ success: true, chats: out });
});

// ====== TELEGRAM WEBHOOK (onayla/reddet butonları) ======
const webhookPath = `/api/telegram-webhook-${TELEGRAM_BOT_TOKEN}`;
app.post(webhookPath, async (req, res) => {
    const update = req.body;
    try {
        if (update.message && update.message.reply_to_message && String(update.message.chat.id) === String(ADMIN_CHAT_ID)) {
            const origId = update.message.reply_to_message.message_id;
            const username = supportMsgMap[origId];
            const replyText = (update.message.text || '').trim();
            if (username && db.users[username] && replyText) {
                if (!db.support[username]) db.support[username] = [];
                db.support[username].push({ from: 'admin', text: replyText, time: new Date().toLocaleString('tr-TR'), ts: Date.now() });
                if (db.support[username].length > 200) db.support[username].shift();
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: ADMIN_CHAT_ID, text: `➡️ ${username} kullanıcısına iletildi.`, reply_to_message_id: update.message.message_id
                });
            }
        }
        if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;

            // Sadece admin butonlara basabilsin
            if (String(chatId) === String(ADMIN_CHAT_ID)) {
                const sep = cb.data.indexOf('|');
                const action = cb.data.slice(0, sep);
                const paymentId = cb.data.slice(sep + 1);
                const payment = db.payments[paymentId];

                if (payment && payment.status === 'pending') {
                    if (action === 'approve') {
                        payment.status = 'approved';
                        if (db.users[payment.username]) db.users[payment.username].balance += payment.amount;
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `✅ Ödeme Onaylandı!\nKullanıcı: ${payment.username}\nTutar: ${payment.amount} TL` });
                    } else if (action === 'reject') {
                        payment.status = 'rejected';
                        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `❌ Ödeme Reddedildi!\nKullanıcı: ${payment.username}` });
                    }
                }
            }
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: cb.id });
        }
    } catch (e) {
        console.error('Webhook hatası:', e.message);
    }
    res.sendStatus(200);
});

// ====== ARAYÜZ ======
// NOT: Aşağıdaki sayfa kodunda ters tırnak (backtick) ve dolar-süslü parantez KULLANILMADI, bilerek.
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="tr" class="dark">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Anka SMS</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    
        <style>
            body { background: #000; }
            #matrix { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; }
            .glitch { animation: glitch 2.5s infinite; text-shadow: 0 0 14px #22c55e; }
            @keyframes glitch { 0%,88%,100% { transform: none; opacity: 1; } 90% { transform: translate(-3px,1px); opacity: .75; } 93% { transform: translate(3px,-1px); } 96% { transform: translate(-2px,0); opacity: .9; } }
            .blink { animation: blink 1s steps(2) infinite; }
            @keyframes blink { 50% { opacity: 0; } }
            .fadeUp { animation: fadeUp 1s ease both; }
            @keyframes fadeUp { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
            .anka { background: linear-gradient(90deg,#f59e0b,#ef4444,#f59e0b); background-size: 200% auto; -webkit-background-clip: text; background-clip: text; color: transparent; animation: flame 3s linear infinite; }
            .anka.glitch { text-shadow: none; filter: drop-shadow(0 0 12px rgba(249,115,22,.75)); animation: flame 3s linear infinite, glitch 2.5s infinite; }
            @keyframes flame { to { background-position: 200% center; } }
            .flameIcon { color: #f97316; text-shadow: 0 0 16px #f97316, 0 0 32px #ef4444; animation: flick 1.3s ease-in-out infinite; }
            @keyframes flick { 0%,100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.12) translateY(-2px); opacity: .85; } }
.phoenixWrap{width:min(420px,80vw);margin:0 auto}
.phoenixWrap svg{width:100%;height:auto;display:block;filter:drop-shadow(0 0 22px rgba(249,115,22,.7))}
.flapR{transform-origin:0 0;animation:flap 1.6s ease-in-out infinite}
@keyframes flap{0%,100%{transform:rotate(16deg)}50%{transform:rotate(-20deg)}}
.birdFloat{animation:floaty 3.2s ease-in-out infinite}
@keyframes floaty{0%,100%{transform:translateY(0)}50%{transform:translateY(-12px)}}
.tailS{transform-origin:0 0;animation:sway 2.6s ease-in-out infinite alternate}
@keyframes sway{from{transform:rotate(-5deg)}to{transform:rotate(5deg)}}
.ember{opacity:0;animation:ember 3s ease-in infinite}
@keyframes ember{0%{opacity:0;transform:translateY(0)}20%{opacity:1}100%{opacity:0;transform:translateY(-90px)}}
            .vipBadge { display: inline-block; margin-left: 8px; padding: 1px 9px; font-size: 11px; font-weight: 900; letter-spacing: 2px; color: #1a1000; background: linear-gradient(90deg,#fde68a,#f59e0b,#fde68a); background-size: 200% auto; border-radius: 6px; animation: shine 3s linear infinite; vertical-align: middle; box-shadow: 0 0 12px rgba(250,204,21,.5); }
            @keyframes shine { to { background-position: 200% center; } }
            .vipCard { border: 1px solid rgba(250,204,21,.55) !important; box-shadow: 0 0 40px rgba(249,115,22,.25), inset 0 0 40px rgba(250,204,21,.05); }
            .neon { box-shadow: 0 0 25px rgba(34,197,94,.25), inset 0 0 25px rgba(34,197,94,.05); }
        </style>
    </head>
    <body class="bg-slate-950 text-slate-100 font-sans min-h-screen flex flex-col justify-between">
        <canvas id="matrix"></canvas>
        <template id="phoenixTpl"><svg viewBox="-40 0 480 430" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Anka kuşu">
<defs>
<filter id="phGlow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<linearGradient id="gFire" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6cf"/><stop offset=".4" stop-color="#ffb23f"/><stop offset=".75" stop-color="#f1591c"/><stop offset="1" stop-color="#a81810"/></linearGradient>
<linearGradient id="gWing" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff6cf"/><stop offset=".38" stop-color="#ffac34"/><stop offset=".72" stop-color="#ef4123"/><stop offset="1" stop-color="#7a1210"/></linearGradient>
<linearGradient id="gTail" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd271"/><stop offset=".5" stop-color="#ef4123"/><stop offset="1" stop-color="#7a0f0f" stop-opacity="0"/></linearGradient>
<radialGradient id="gGlow"><stop offset="0" stop-color="#fb923c" stop-opacity=".55"/><stop offset="1" stop-color="#fb923c" stop-opacity="0"/></radialGradient>
<path id="ftW" d="M0 0 C40 -20 110 -26 168 -6 C150 -2 140 2 178 4 C140 10 128 14 160 22 C122 20 104 24 130 34 C96 26 70 18 0 0 Z"/>
<path id="ftT" d="M0 0 C-14 55 -11 125 0 185 C11 125 14 55 0 0 Z"/>
</defs>
<circle cx="200" cy="190" r="200" fill="url(#gGlow)"/>
<g class="ember-layer">
<circle class="ember" cx="90" cy="330" r="3" fill="#fde047" style="animation-delay:.1s"/>
<circle class="ember" cx="130" cy="380" r="2.5" fill="#fb923c" style="animation-delay:1.1s"/>
<circle class="ember" cx="170" cy="350" r="3.5" fill="#fde047" style="animation-delay:2s"/>
<circle class="ember" cx="215" cy="395" r="2.5" fill="#fbbf24" style="animation-delay:.6s"/>
<circle class="ember" cx="255" cy="345" r="3" fill="#fb923c" style="animation-delay:1.6s"/>
<circle class="ember" cx="300" cy="385" r="3.5" fill="#fde047" style="animation-delay:.3s"/>
<circle class="ember" cx="335" cy="320" r="2.5" fill="#fbbf24" style="animation-delay:2.3s"/>
<circle class="ember" cx="60" cy="260" r="2.5" fill="#fb923c" style="animation-delay:1.4s"/>
<circle class="ember" cx="350" cy="250" r="3" fill="#fde047" style="animation-delay:.8s"/>
<circle class="ember" cx="25" cy="190" r="2" fill="#fbbf24" style="animation-delay:2.6s"/>
<circle class="ember" cx="380" cy="180" r="2" fill="#fb923c" style="animation-delay:1.9s"/>
</g>
<g class="birdFloat" filter="url(#phGlow)">
<g transform="translate(200 232)"><g class="tailS">
<use href="#ftT" fill="url(#gTail)" transform="rotate(-44) scale(.72)"/>
<use href="#ftT" fill="url(#gTail)" transform="rotate(44) scale(.72)"/>
<use href="#ftT" fill="url(#gTail)" transform="rotate(-26) scale(.88)"/>
<use href="#ftT" fill="url(#gTail)" transform="rotate(26) scale(.88)"/>
<use href="#ftT" fill="url(#gTail)" transform="rotate(-9) scale(1)"/>
<use href="#ftT" fill="url(#gTail)" transform="rotate(9) scale(1)"/>
</g></g>
<g transform="translate(212 146)"><g class="flapR">
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".4" transform="rotate(-92) scale(.42)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-80) scale(.6)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-62) scale(.78)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-44) scale(.94)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-26) scale(1)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-8) scale(.96)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(10) scale(.8)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(27) scale(.6)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".4" transform="rotate(40) scale(.4)"/>
</g></g>
<g transform="translate(188 146) scale(-1 1)"><g class="flapR">
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".4" transform="rotate(-92) scale(.42)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-80) scale(.6)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-62) scale(.78)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-44) scale(.94)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-26) scale(1)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(-8) scale(.96)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(10) scale(.8)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".55" transform="rotate(27) scale(.6)"/>
<use href="#ftW" fill="url(#gWing)" stroke="#fde68a" stroke-opacity=".4" transform="rotate(40) scale(.4)"/>
</g></g>
<path d="M200 112 C172 118 164 160 178 200 C186 226 194 238 200 248 C206 238 214 226 222 200 C236 160 228 118 200 112 Z" fill="url(#gFire)" stroke="#fde68a" stroke-opacity=".6"/>
<path d="M184 158 q16 13 32 0 M182 180 q18 15 36 0 M185 202 q15 13 30 0" fill="none" stroke="#fff7ae" stroke-opacity=".65" stroke-width="2" stroke-linecap="round"/>
<path d="M200 76 C190 54 206 38 198 8 C217 34 215 57 208 76 Z" fill="#fde047"/>
<path d="M189 82 C170 68 177 47 160 34 C187 41 199 59 198 82 Z" fill="#fb923c"/>
<path d="M211 82 C230 68 223 47 240 34 C213 41 201 59 202 82 Z" fill="#fb923c"/>
<path d="M200 73 C182 73 170 86 170 102 C170 118 183 131 200 133 C217 131 230 118 230 102 C230 86 218 73 200 73 Z" fill="url(#gFire)" stroke="#fde68a" stroke-opacity=".6"/>
<path d="M190 112 L200 140 L210 112 C204 117 196 117 190 112 Z" fill="#ffd271" stroke="#92400e" stroke-opacity=".5"/>
<path d="M178 99 C182 93 191 92 196 97 C190 101 183 103 178 99 Z" fill="#fff6cf"/>
<path d="M222 99 C218 93 209 92 204 97 C210 101 217 103 222 99 Z" fill="#fff6cf"/>
<path d="M178 99 C182 95 189 94 193 97" fill="none" stroke="#2a0a02" stroke-opacity=".6" stroke-width="1.2"/>
<path d="M222 99 C218 95 211 94 207 97" fill="none" stroke="#2a0a02" stroke-opacity=".6" stroke-width="1.2"/>
</g>
</svg></template>
        <div id="introOverlay" onclick="closeIntro()" style="position:fixed;top:0;left:0;right:0;bottom:0;z-index:100;background:#000;display:flex;align-items:center;justify-content:center;transition:opacity .8s;cursor:pointer;">
            <div class="font-mono text-emerald-400 text-sm md:text-lg p-6" style="max-width:92%;text-shadow:0 0 8px #22c55e;">
                <div id="introPhoenix" class="phoenixWrap" style="width:min(300px,70vw);margin-bottom:6px"></div>
                <span id="introText"></span><span class="blink">&#9608;</span>
                <p class="text-emerald-700 text-xs mt-6">(geçmek için dokun)</p>
            </div>
        </div>
        <div class="max-w-5xl mx-auto w-full p-4 relative z-10">
            <header class="flex justify-between items-center py-4 px-6 border border-emerald-500/30 mb-6 bg-black/70 backdrop-blur rounded-2xl shadow-2xl neon">
                <div class="flex items-center gap-3">
                    <div class="bg-orange-500/15 p-2.5 rounded-xl border border-orange-500/50">
                        <i class="fa-solid fa-fire-flame-curved text-xl flameIcon"></i>
                    </div>
                    <div>
                        <h1 class="anka text-2xl font-black tracking-widest inline-block">ANKA SMS</h1><span class="vipBadge">VIP</span>
                        <p class="text-[10px] text-emerald-500/80 font-mono">KÜLLERİNDEN DOĞAN SİSTEM</p>
                    </div>
                </div>
                <div id="userArea" class="flex items-center gap-4"></div>
            </header>
            <main id="mainContent"></main>
        </div>

        <div id="authModal" class="fixed inset-0 bg-black/85 flex items-center justify-center hidden z-50">
            <div class="bg-slate-900 border border-emerald-500/40 p-8 rounded-3xl w-full max-w-md relative shadow-2xl">
                <button onclick="closeAuthModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
                <div class="text-center mb-6"><h2 id="authTitle" class="text-2xl font-black text-white">Giriş Yap</h2></div>
                <div class="space-y-4">
                    <input type="text" id="authUsername" placeholder="Kullanıcı Adı" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:border-emerald-500">
                    <input type="password" id="authPassword" placeholder="Şifre" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:border-emerald-500">
                    <button onclick="handleAuthSubmit()" id="authSubmitBtn" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl transition">Giriş Yap</button>
                    <p class="text-center text-sm text-slate-400"><span onclick="switchAuthMode()" id="switchText" class="text-emerald-400 cursor-pointer underline">Kayıt Ol</span></p>
                </div>
            </div>
        </div>

        <div id="depositModal" class="fixed inset-0 bg-black/85 flex items-center justify-center hidden z-50">
            <div class="bg-slate-900 border border-emerald-500/40 p-8 rounded-3xl w-full max-w-md relative shadow-2xl">
                <button onclick="closeDeposit()" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
                <h2 class="text-xl font-black mb-4 text-emerald-400"><i class="fa-solid fa-wallet"></i> Bakiye Yükle (IBAN)</h2>
                <div class="space-y-4 text-sm text-slate-300">
                    <div class="bg-slate-950 p-4 rounded-xl border border-emerald-500/20">
                        <p class="text-slate-500 text-xs">Banka IBAN:</p>
                        <p class="font-mono text-emerald-400 font-bold text-base select-all">TR62 0006 2000 5000 0006 8107 73</p>
                        <p class="text-slate-500 text-xs mt-2">Alıcı:</p>
                        <p class="font-bold text-white text-base">Resul Sakal</p>
                    </div>
                    <input type="text" id="depositSender" placeholder="Gönderen Ad Soyad" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white">
                    <input type="number" id="depositAmount" placeholder="Tutar (TL)" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white">
                    <button onclick="submitDeposit()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl">Bildirim Gönder</button>
                </div>
            </div>
        </div>

        <script>
            var currentUser = localStorage.getItem('currentUser') || null;
            var currentRole = localStorage.getItem('currentRole') || 'user';
            var isRegisterMode = false;
            var activeTimerInterval = null;
            var stockRefreshInterval = null;
            var searchTimer = null;

            function init() {
                updateUserArea();
                if (currentUser) {
                    buildMain();
                    loadServices();
                    restoreOrders();
                    if (stockRefreshInterval) clearInterval(stockRefreshInterval);
                    stockRefreshInterval = setInterval(loadServices, 20000);
                }
            }

            function buildMain() {
                document.getElementById('mainContent').innerHTML =
                    '<div id="servicesGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4"><p class="text-slate-400 text-sm">Yükleniyor...</p></div>' +
                    '<div class="mt-6 flex justify-end"><button onclick="openDeposit()" class="bg-emerald-600 hover:bg-emerald-500 px-6 py-3 rounded-xl font-bold text-sm"><i class="fa-solid fa-wallet mr-2"></i> Bakiye Yükle</button></div>' +
                    '<div id="activeOrderArea" class="mt-8"></div>';
            }

            function openDeposit() { document.getElementById('depositModal').classList.remove('hidden'); }
            function closeDeposit() { document.getElementById('depositModal').classList.add('hidden'); }

            function onSearch() {
                if (searchTimer) clearTimeout(searchTimer);
                searchTimer = setTimeout(loadServices, 400);
            }

            function updateUserArea() {
                var area = document.getElementById('userArea');
                if (currentUser) {
                    area.innerHTML =
                        '<div class="flex items-center gap-3">' +
                        '<span class="text-sm font-medium">@<strong class="text-white">' + currentUser + '</strong></span>' +
                        '<span id="userBalance" class="bg-emerald-500/10 text-emerald-400 px-3.5 py-1.5 rounded-full text-xs font-bold border border-emerald-500/30">0.00 TL</span>' +
                        (currentRole === 'admin' ? '<button onclick="openAdminPanel()" class="bg-amber-600 hover:bg-amber-500 px-3.5 py-1.5 rounded-xl text-xs font-bold">Admin Panel</button>' : '') +
                        '<button onclick="logout()" class="text-red-400 text-sm p-2"><i class="fa-solid fa-right-from-bracket"></i></button>' +
                        '</div>';
                    fetchBalance();
                } else {
                    area.innerHTML =
                        '<button onclick="openAuthModal(\\'login\\')" class="bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-xl text-sm font-bold">Giriş Yap</button>' +
                        '<button onclick="openAuthModal(\\'register\\')" class="bg-slate-800 hover:bg-slate-700 px-5 py-2.5 rounded-xl text-sm font-bold">Kayıt Ol</button>';
                    document.getElementById('mainContent').innerHTML =
                        '<div class="text-center py-16 bg-black/70 backdrop-blur rounded-3xl border border-emerald-500/30 p-8 fadeUp neon vipCard">' +
                        '<div class="phoenixWrap">' + phoenixHTML() + '</div>' +
                        '<div class="mb-3 mt-2"><span class="vipBadge">VIP ÜYELİK PANELİ</span></div>' +
                        '<h2 class="glitch anka text-5xl md:text-6xl font-black mb-4 font-mono tracking-widest">ANKA SMS</h2>' +
                        '<p class="text-emerald-300/80 font-mono mb-8">Anlık sanal numara &bull; Hızlı SMS kodu &bull; 7/24 aktif<span class="blink">_</span></p>' +
                        '<div class="flex gap-3 justify-center"><button onclick="openLogin()" class="bg-emerald-600 hover:bg-emerald-500 px-8 py-3 rounded-xl font-bold neon">Giriş Yap</button>' +
                        '<button onclick="openRegister()" class="bg-black/60 border border-emerald-500/40 hover:bg-emerald-900/40 px-8 py-3 rounded-xl font-bold text-emerald-300">Kayıt Ol</button></div></div>';
                }
            }

            async function fetchBalance() {
                if (!currentUser) return;
                var res = await fetch('/api/getCustomerBalance?username=' + encodeURIComponent(currentUser));
                var data = await res.json();
                var el = document.getElementById('userBalance');
                if (data.success && el) el.innerText = data.balance.toFixed(2) + ' TL';
            }

            async function loadServices() {
                if (!currentUser) return;
                var grid = document.getElementById('servicesGrid');
                if (!grid) return; // admin panelindeyken çalışmasın
                var q = '';
                try {
                    var res = await fetch('/api/getServices?q=' + encodeURIComponent(q));
                    var data = await res.json();
                    if (!data.success) {
                        grid.innerHTML = '<p class="text-red-400 text-sm">Sağlayıcıya bağlanılamadı: ' + (data.message || '') + '</p>';
                        return;
                    }
                    if (data.services.length === 0) {
                        grid.innerHTML = '<p class="text-slate-400 text-sm">Stokta servis bulunamadı.</p>';
                        return;
                    }
                    var html = '';
                    data.services.forEach(function (s) { html += renderServiceCard(s); });
                    grid.innerHTML = html;
                } catch (e) {}
            }

            function renderServiceCard(s) {
                return '<div class="bg-black/70 backdrop-blur border border-emerald-500/20 p-5 rounded-2xl flex items-center justify-between shadow-xl hover:border-emerald-400 transition">' +
                    '<div class="flex items-center gap-4">' +
                    '<div class="' + s.bg + ' ' + s.color + ' w-12 h-12 rounded-xl flex items-center justify-center text-xl border border-emerald-500/20"><i class="' + s.iconType + ' ' + s.icon + '"></i></div>' +
                    '<div><h3 class="font-bold text-sm text-white">' + s.name + '</h3>' +
                    '<p class="text-emerald-400 font-bold text-sm">' + s.price.toFixed(2) + ' TL</p></div>' +
                    '</div>' +
                    '<button data-id="' + s.id + '" onclick="buyNumber(this)" class="bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg transition">Numara Al</button>' +
                    '</div>';
            }

            async function buyNumber(btn) {
                var productId = btn.getAttribute('data-id');
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Alınıyor...';

                try {
                    var res = await fetch('/api/buyNumber', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ productId: productId, username: currentUser })
                    });
                    var data = await res.json();
                    btn.disabled = false;
                    btn.innerText = 'Numara Al';

                    if (data.success) {
                        fetchBalance();
                        trackOrder(data.order.activationId, data.order.phoneNumber, 600, data.order.productName, null);
                    } else {
                        alert(data.message);
                        loadServices();
                    }
                } catch (e) {
                    btn.disabled = false;
                    btn.innerText = 'Numara Al';
                    alert('Bağlantı hatası, tekrar deneyin.');
                }
            }

            var orderTimers = {};

            function trackOrder(id, phone, timeLeft, productName, doneCode) {
                var area = document.getElementById('activeOrderArea');
                if (!area) return;
                var old = document.getElementById('order_' + id);
                if (old) old.parentNode.removeChild(old);
                if (orderTimers[id]) { clearInterval(orderTimers[id]); delete orderTimers[id]; }
                var done = !!doneCode;

                var card = document.createElement('div');
                card.id = 'order_' + id;
                card.className = 'bg-slate-900 border border-emerald-500 p-6 rounded-2xl shadow-2xl relative mb-4';
                card.innerHTML =
                    '<h3 class="font-bold text-emerald-400 text-lg mb-3"><i class="fa-solid fa-circle-check mr-2"></i> ' + (productName || 'Numara') + '</h3>' +
                    '<p class="text-sm text-slate-300">Numara: <strong class="text-white font-mono text-xl select-all">' + phone + '</strong></p>' +
                    '<p class="text-sm text-slate-300 mt-2">SMS Kod: <strong id="smsCode_' + id + '" class="text-emerald-400 font-mono text-xl ' + (done ? '' : 'animate-pulse') + '">' + (done ? doneCode : 'Bekleniyor...') + '</strong></p>' +
                    '<div class="mt-4 flex items-center justify-between border-t border-slate-800 pt-4">' +
                    '<span class="text-xs text-slate-400">' + (done ? '' : 'Kod Süresi: <strong id="timerDisplay_' + id + '" class="text-amber-400 font-mono text-sm">--:--</strong>') + '</span>' +
                    '<div id="actionButtons_' + id + '">' + (done
                        ? '<span class="text-emerald-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>'
                        : '<button data-id="' + id + '" onclick="cancelBtn(this)" class="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-500/40 px-4 py-2 rounded-xl text-xs font-bold transition">Değiştir / İptal Et</button>') +
                    '</div></div>';
                area.insertBefore(card, area.firstChild);
                if (done) return;

                var tick = 0;
                orderTimers[id] = setInterval(async function () {
                    timeLeft--; tick++;
                    var min = Math.floor(timeLeft / 60);
                    var sec = timeLeft % 60;
                    var timerEl = document.getElementById('timerDisplay_' + id);
                    if (timerEl) timerEl.innerText = String(Math.max(min, 0)).padStart(2, '0') + ':' + String(Math.max(sec, 0)).padStart(2, '0');

                    if (timeLeft <= 0) {
                        clearInterval(orderTimers[id]); delete orderTimers[id];
                        cancelOrder(id, true);
                        return;
                    }
                    if (tick % 5 !== 0) return; // SMS'i 5 saniyede bir sorgula

                    try {
                        var res = await fetch('/api/checkSms/' + id);
                        var data = await res.json();
                        if (data.success && data.status === 'completed') {
                            clearInterval(orderTimers[id]); delete orderTimers[id];
                            var codeEl = document.getElementById('smsCode_' + id);
                            if (codeEl) { codeEl.innerText = data.code; codeEl.classList.remove('animate-pulse'); }
                            var actionArea = document.getElementById('actionButtons_' + id);
                            if (actionArea) actionArea.innerHTML = '<span class="text-emerald-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>';
                            var tEl = document.getElementById('timerDisplay_' + id);
                            if (tEl) tEl.parentNode.innerHTML = '';
                            alert('SMS Kodunuz Geldi: ' + data.code);
                        }
                    } catch (e) {}
                }, 1000);
            }

            async function restoreOrders() {
                if (!currentUser) return;
                try {
                    var res = await fetch('/api/myOrders?username=' + encodeURIComponent(currentUser));
                    var data = await res.json();
                    if (!data.success) return;
                    data.orders.slice().reverse().forEach(function (o) {
                        trackOrder(o.activationId, o.phoneNumber, o.remaining, o.productName, o.status === 'completed' ? o.code : null);
                    });
                } catch (e) {}
            }

            function cancelBtn(btn) { cancelOrder(btn.getAttribute('data-id'), false); }

            async function cancelOrder(id, isTimeout) {
                if (!isTimeout && !confirm('Bu numarayı iptal etmek istediğinize emin misiniz? Bakiyeniz hesabınıza iade edilecektir.')) return;

                var res = await fetch('/api/cancelNumber', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ activationId: id, username: currentUser })
                });
                var data = await res.json();
                alert(data.message);
                fetchBalance();
                if (data.success) {
                    if (orderTimers[id]) { clearInterval(orderTimers[id]); delete orderTimers[id]; }
                    var card = document.getElementById('order_' + id);
                    if (card) card.parentNode.removeChild(card);
                }
            }

            function openAuthModal(mode) {
                isRegisterMode = (mode === 'register');
                document.getElementById('authTitle').innerText = isRegisterMode ? 'Kayıt Ol' : 'Giriş Yap';
                document.getElementById('authSubmitBtn').innerText = isRegisterMode ? 'Kayıt Ol' : 'Giriş Yap';
                document.getElementById('switchText').innerText = isRegisterMode ? 'Zaten hesabın var mı? Giriş Yap' : 'Hesabın yok mu? Kayıt Ol';
                document.getElementById('authModal').classList.remove('hidden');
            }
            function closeAuthModal() { document.getElementById('authModal').classList.add('hidden'); }
            function switchAuthMode() { openAuthModal(isRegisterMode ? 'login' : 'register'); }

            async function handleAuthSubmit() {
                var username = document.getElementById('authUsername').value;
                var password = document.getElementById('authPassword').value;
                var endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
                var res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username, password: password })
                });
                var data = await res.json();
                if (data.success) {
                    currentUser = data.username;
                    currentRole = data.role || 'user';
                    localStorage.setItem('currentUser', currentUser);
                    localStorage.setItem('currentRole', currentRole);
                    closeAuthModal();
                    init();
                } else {
                    alert(data.message);
                }
            }

            async function submitDeposit() {
                var senderName = document.getElementById('depositSender').value;
                var amount = document.getElementById('depositAmount').value;
                var res = await fetch('/api/deposit/notify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: currentUser, senderName: senderName, amount: amount })
                });
                var data = await res.json();
                alert(data.message);
                closeDeposit();
            }

            async function openAdminPanel() {
                var res = await fetch('/api/admin/getData?adminUsername=' + encodeURIComponent(currentUser));
                var data = await res.json();
                if (!data.success) return alert('Yetkisiz!');

                var paymentsHtml = '';
                for (var id in data.payments) {
                    var p = data.payments[id];
                    if (p.status === 'pending') {
                        paymentsHtml += '<div class="bg-slate-950 p-4 rounded-xl mb-2 flex justify-between items-center"><span>' + p.username + ' - ' + p.amount + ' TL (' + p.senderName + ')</span><div>' +
                            '<button onclick="processPay(\\'' + p.id + '\\',\\'approve\\')" class="bg-emerald-600 px-3 py-1 rounded text-xs font-bold mr-1">Onayla</button>' +
                            '<button onclick="processPay(\\'' + p.id + '\\',\\'reject\\')" class="bg-red-600 px-3 py-1 rounded text-xs font-bold">Reddet</button></div></div>';
                    }
                }

                document.getElementById('mainContent').innerHTML =
                    '<div class="bg-slate-900 border border-amber-500/30 p-6 rounded-2xl">' +
                    '<div class="flex justify-between items-center mb-4"><h2 class="text-xl font-bold text-amber-400">Admin Paneli</h2><button onclick="location.reload();" class="bg-slate-800 px-4 py-2 rounded-xl text-xs font-bold">Geri Dön</button></div>' +
                    '<h3 class="font-bold mb-2">Bekleyen Ödemeler</h3>' +
                    (paymentsHtml || '<p class="text-sm text-slate-500 mb-4">Bekleyen ödeme yok.</p>') +
                    '<a href="/api/admin/testApi?adminUsername=' + encodeURIComponent(currentUser) + '" target="_blank" class="inline-block bg-blue-600 px-4 py-2 rounded-xl text-xs font-bold text-white mt-4">Sağlayıcı Bağlantı / Bakiye Testi (JSON)</a>' +
                    '</div>';
            }

            async function processPay(paymentId, action) {
                await fetch('/api/admin/processPayment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ adminUsername: currentUser, paymentId: paymentId, action: action })
                });
                openAdminPanel();
            }

            function logout() {
                if (stockRefreshInterval) clearInterval(stockRefreshInterval);
                localStorage.clear();
                currentUser = null;
                currentRole = 'user';
                init();
            }
                        function openLogin() { openAuthModal('login'); }
            function openRegister() { openAuthModal('register'); }

            function startMatrix() {
                var c = document.getElementById('matrix');
                if (!c) return;
                var ctx = c.getContext('2d');
                var chars = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉ0123456789ABCDEFXYZ'.split('');
                var fs = 16, drops = [];
                function resize() {
                    c.width = window.innerWidth;
                    c.height = window.innerHeight;
                    var cols = Math.floor(c.width / fs);
                    drops = [];
                    for (var i = 0; i < cols; i++) drops[i] = Math.random() * c.height / fs;
                }
                resize();
                window.addEventListener('resize', resize);
                setInterval(function () {
                    ctx.fillStyle = 'rgba(0,0,0,0.08)';
                    ctx.fillRect(0, 0, c.width, c.height);
                    ctx.font = fs + 'px monospace';
                    for (var i = 0; i < drops.length; i++) {
                        var ch = chars[Math.floor(Math.random() * chars.length)];
                        ctx.fillStyle = Math.random() > 0.96 ? '#d1fae5' : '#22c55e';
                        ctx.fillText(ch, i * fs, drops[i] * fs);
                        if (drops[i] * fs > c.height && Math.random() > 0.975) drops[i] = 0;
                        drops[i] += 1;
                    }
                }, 50);
            }

            var phoenixCount = 0;
            function phoenixHTML() {
                var t = document.getElementById('phoenixTpl');
                if (!t) return '';
                phoenixCount++; // her kopyanın gradient/id'leri benzersiz olsun (gizli kopya diğerini bozmasın)
                return t.innerHTML.replace(/(gFire|gWing|gTail|gGlow|ftW|ftT)/g, '$1_' + phoenixCount);
            }

            var introClosed = false;
            function closeIntro() {
                if (introClosed) return;
                introClosed = true;
                var o = document.getElementById('introOverlay');
                if (!o) return;
                o.style.opacity = '0';
                setTimeout(function () { o.style.display = 'none'; }, 850);
            }

            function runIntro() {
                var ip = document.getElementById('introPhoenix');
                if (ip) ip.innerHTML = phoenixHTML();
                var lines = ['> SİSTEM BAŞLATILIYOR...', '> GÜVENLİ BAĞLANTI KURULUYOR...', '> SAĞLAYICI AĞINA ERİŞİLİYOR...', '> ERİŞİM İZNİ VERİLDİ', '> ANKA KÜLLERİNDEN DOĞUYOR...', '> HOŞ GELDİN: ANKA SMS'];
                var el = document.getElementById('introText');
                var out = '', li = 0, ci = 0;
                function tick() {
                    if (introClosed) return;
                    if (li >= lines.length) { setTimeout(closeIntro, 700); return; }
                    var line = lines[li];
                    if (ci < line.length) {
                        ci++;
                        el.innerHTML = out + line.substring(0, ci);
                        setTimeout(tick, 28);
                    } else {
                        out += line + '<br>';
                        el.innerHTML = out;
                        li++; ci = 0;
                        setTimeout(tick, 250);
                    }
                }
                tick();
            }
            window.onload = function () { startMatrix(); runIntro(); init(); };
        </script>
    </body>
    </html>
    `);
});

// Sağlayıcı bakiyesi düşükse otomatik Telegram uyarısı (15 dakikada bir kontrol)
setInterval(async () => {
    try {
        const r = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getBalance' }, timeout: 15000 });
        const m = String(r.data || '').match(/ACCESS_BALANCE:([0-9.]+)/);
        if (m) {
            const bal = parseFloat(m[1]);
            if (bal < LOW_BALANCE_THRESHOLD) await notifyLowProviderBalance('⚠️ OnaylaSMS bakiyen azaldı: ' + bal + ' TL. Lütfen yükleme yap.');
        }
    } catch (e) {}
}, 15 * 60 * 1000);

setInterval(async () => {
    const now = Date.now();
    for (const id in db.orders) {
        const o = db.orders[id];
        if (o.status !== 'waiting' || !o.createdAt || now - o.createdAt < 11 * 60 * 1000) continue;
        o.sweepTries = (o.sweepTries || 0) + 1;
        if (o.sweepTries > 5) { o.status = 'expired'; continue; }
        try {
            const st = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getStatus', id: id }, timeout: 15000 });
            const t = String(st.data || '').trim();
            if (t.startsWith('STATUS_OK')) { o.code = t.split(':').slice(1).join(':'); o.status = 'completed'; continue; }
            const c = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'setStatus', status: 8, id: id }, timeout: 15000 });
            if (String(c.data || '').trim().startsWith('ACCESS_CANCEL') && db.users[o.username]) {
                db.users[o.username].balance += o.price;
                o.status = 'cancelled';
            }
        } catch (e) {}
    }
}, 60000);

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    if (!ONAYLI_SMS_API_KEY) console.warn('UYARI: ONAYLI_SMS_API_KEY ayarlanmamış!');
    try {
        const webhookUrl = `${RENDER_EXTERNAL_URL}${webhookPath}`;
        await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    } catch (err) {}
});
