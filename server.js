const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ====== AYARLAR (Render > Environment bölümünden girilecek) ======
const PORT = process.env.PORT || 10000;
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
app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="tr" class="dark">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Anka SMS</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body { background: #000; color: #fff; font-family: sans-serif; }
        #matrix { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; }
        .anka { background: linear-gradient(90deg,#f59e0b,#ef4444,#f59e0b); -webkit-background-clip: text; background-clip: text; color: transparent; }
    </style>
</head>
<body class="flex items-center justify-center min-h-screen">
    <div class="text-center z-10 p-6 bg-zinc-900/80 rounded-xl border border-zinc-800 backdrop-blur">
        <h1 class="text-4xl font-bold anka mb-2">Anka SMS Panel</h1>
        <p class="text-zinc-400">Sistem aktif ve Render üzerinde sorunsuz çalışıyor.</p>
    </div>
</body>
</html>`);
});

// ====== RENDER İÇİN SUNUCUYU BAŞLATMA ======
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Sunucu ${PORT} portunda başarıyla başlatıldı ve dinleniyor.`);
});
