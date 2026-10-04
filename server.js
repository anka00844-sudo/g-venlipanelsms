const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ====== AYARLAR (Render > Environment bölümünden de girilebilir) ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const ADMIN_TELEGRAM_USERNAME = process.env.ADMIN_TELEGRAM_USERNAME || 'vipankaa'; // destek için görünen iletişim kanalı
const ADMIN_WHATSAPP = process.env.ADMIN_WHATSAPP || '573181006792'; // wa.me linki için ülke koduyla, başında + ve boşluk olmadan
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://yenipanel.onrender.com';
const ONAYLI_SMS_API_KEY = process.env.ONAYLI_SMS_API_KEY || 'osms_7f193a3fe65448a9380061c1b56e9fdc29f49c67e89eb3dd';
const ONAYLI_SMS_URL = 'https://onaylasms.com.tr/stubs/handler_api.php';
// Sağlayıcı bakiyesi bu değerin altına düşünce Telegram'dan otomatik uyarı gelir
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
let supportMsgMap = {}; // telegram mesaj id -> username (adminin hangi mesaja cevap verdiğini eşlemek için)

app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!db.visitors.some(v => v.ip === ip)) {
        db.visitors.unshift({ ip, time: new Date().toLocaleString('tr-TR') });
        if (db.visitors.length > 80) db.visitors.pop();
    }
    next();
});

function isAdmin(name) {
    return db.users[name] && db.users[name].role === 'admin';
}

// ====== SABİT ÜRÜN KATALOĞU (sadece bu 4 ürün satılır) ======
const CATALOG = [
    { id: 'wa_tr', key: 'tr', name: 'WhatsApp Türkiye', serviceCode: 'wa', defCountry: '62', price: 300 },
    { id: 'tg_tr', key: 'tr', name: 'Telegram Türkiye', serviceCode: 'tg', defCountry: '62', price: 200 },
    { id: 'wa_ph', key: 'ph', name: 'WhatsApp Filipinler', serviceCode: 'wa', defCountry: '4', price: 200 },
    { id: 'tg_us', key: 'us', name: 'Telegram ABD', serviceCode: 'tg', defCountry: '187', alt: ['12'], price: 200 }
];
const SERVICE_INFO = {
    wa: { name: 'WhatsApp', icon: 'fa-whatsapp', bg: 'bg-emerald-500/10', color: 'text-emerald-400' },
    tg: { name: 'Telegram', icon: 'fa-telegram', bg: 'bg-blue-500/10', color: 'text-blue-400' }
};
function nameHas(key, n) {
    if (key === 'tr') return n.includes('turkey') || n.includes('türkiye') || n.includes('turkiye') || n.includes('турци');
    if (key === 'ph') return n.includes('philippines') || n.includes('филиппин');
    if (key === 'us') return /\busa\b/.test(n) || n.includes('united states') || n.includes('сша');
    return false;
}

// ====== Sağlayıcıdan ülke ID'lerini otomatik bul (1 saatte bir yenile) ======
let countryCache = { time: 0, map: {}, all: {} };
async function resolveCountries() {
    if (countryCache.time && Date.now() - countryCache.time < 3600000) return countryCache;
    const map = {};
    const all = { tr: [], ph: [], us: [] };
    try {
        const r = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getCountries' }, timeout: 15000 });
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        if (d && typeof d === 'object') {
            const arr = Array.isArray(d) ? d : Object.keys(d).map(k => Object.assign({ _k: k }, typeof d[k] === 'object' ? d[k] : { name: d[k] }));
            for (const c of arr) {
                if (!c || typeof c !== 'object') continue;
                const id = c.id !== undefined ? String(c.id) : (c._k !== undefined ? String(c._k) : null);
                if (id === null) continue;
                const names = [c.eng, c.rus, c.name, c.title, c.tr, c.country].filter(Boolean).map(x => String(x).toLowerCase().trim());
                for (const key in all) {
                    if (names.some(n => nameHas(key, n))) { if (!map[key]) map[key] = id; if (!all[key].includes(id)) all[key].push(id); }
                }
            }
        }
    } catch (e) {}
    countryCache = { time: Date.now(), map, all };
    return countryCache;
}
// Bir ürün için denenecek ülke ID listesi: sağlayıcıdan otomatik bulunan + varsayılan + elle eklenen alternatifler
async function countryCandidates(item) {
    const { map, all } = await resolveCountries();
    const list = [];
    const primary = map[item.key] || item.defCountry;
    list.push(primary);
    (all[item.key] || []).forEach(id => { if (!list.includes(id)) list.push(id); });
    (item.alt || []).forEach(id => { if (!list.includes(id)) list.push(id); });
    if (!list.includes(item.defCountry)) list.push(item.defCountry);
    return list;
}

// ====== SERVİS LİSTESİ (sabit katalog, stok yazısı yok) ======
app.get('/api/getServices', (req, res) => {
    const list = CATALOG.map(item => {
        const meta = SERVICE_INFO[item.serviceCode];
        return { id: item.id, name: item.name, price: item.price, icon: meta.icon, bg: meta.bg, color: meta.color };
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

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (db.users[username] && db.users[username].password === password) {
        db.logins.unshift({ username, ip, time: new Date().toLocaleString('tr-TR'), ts: Date.now() });
        if (db.logins.length > 300) db.logins.length = 300;
        res.json({ success: true, username, role: db.users[username].role });
    } else {
        res.json({ success: false, message: "Hatalı kullanıcı adı veya şifre!" });
    }
});

app.post('/api/auth/register', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.json({ success: false, message: "Alanlar boş bırakılamaz." });
    if (db.users[username]) return res.json({ success: false, message: "Bu kullanıcı adı zaten alınmış." });

    db.users[username] = { username, password, balance: 0, role: "user", createdAt: Date.now(), registeredAt: new Date().toLocaleString('tr-TR') };
    res.json({ success: true, username, role: "user" });
});

app.post('/api/deposit/notify', async (req, res) => {
    const { username, senderName, amount } = req.body;
    if (!username || !senderName || !amount) return res.json({ success: false, message: "Tüm alanları doldurun." });

    const paymentId = 'pay_' + Date.now();
    db.payments[paymentId] = { id: paymentId, username, senderName, amount: parseFloat(amount), status: 'pending', time: new Date().toLocaleString('tr-TR'), ts: Date.now() };

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `💰 Yeni Ödeme Bildirimi!\n\nKullanıcı: ${username}\nGönderen: ${senderName}\nTutar: ${amount} TL`,
            reply_markup: { inline_keyboard: [[{ text: "✅ Onayla", callback_data: `approve|${paymentId}` }, { text: "❌ Reddet", callback_data: `reject|${paymentId}` }]] }
        });
    } catch (e) {}

    res.json({ success: true, message: "Ödeme bildiriminiz alındı. İnceleniyor." });
});

// ====== ADMIN: her şeyi tek seferde getir ======
app.get('/api/admin/getData', (req, res) => {
    const { adminUsername } = req.query;
    if (!isAdmin(adminUsername)) return res.status(403).json({ success: false, message: "Yetkisiz erişim." });

    const users = Object.values(db.users).map(u => ({ username: u.username, balance: u.balance, role: u.role, registeredAt: u.registeredAt || '-' }));
    const payments = Object.values(db.payments).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const logins = db.logins.slice(0, 100);
    const orders = Object.values(db.orders).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 100);
    const supportChats = Object.keys(db.support).map(u => ({ username: u, last: db.support[u][db.support[u].length - 1], count: db.support[u].length })).sort((a, b) => (b.last ? b.last.ts : 0) - (a.last ? a.last.ts : 0));

    res.json({ success: true, users, payments, logins, orders, supportChats, visitors: db.visitors.length });
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

// Sağlayıcı bağlantı testi: bakiye + her ürün için denenecek ülke ID'leri
app.get('/api/admin/testApi', async (req, res) => {
    if (!isAdmin(req.query.adminUsername)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    try {
        const balResp = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getBalance' }, timeout: 20000 });
        countryCache.time = 0;
        const { map, all } = await resolveCountries();
        const urunler = [];
        for (const item of CATALOG) {
            urunler.push({ urun: item.name, denenecekUlkeler: await countryCandidates(item) });
        }
        res.json({ success: true, providerBalance: balResp.data, bulunanUlkeIdleri: map, tumAdaylar: all, urunler });
    } catch (e) {
        res.json({ success: false, error: e.message });
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
        const sent = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_CHAT_ID, text: `💬 Destek | ${username}:\n${msg.text}` });
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
    res.json({ success: true, messages: list, contact: ADMIN_TELEGRAM_USERNAME, whatsapp: ADMIN_WHATSAPP });
});

app.post('/api/admin/support/reply', async (req, res) => {
    const { adminUsername, username, text } = req.body;
    if (!isAdmin(adminUsername)) return res.json({ success: false });
    if (!db.users[username] || !text || !text.trim()) return res.json({ success: false });
    if (!db.support[username]) db.support[username] = [];
    db.support[username].push({ from: 'admin', text: text.trim().slice(0, 1000), time: new Date().toLocaleString('tr-TR'), ts: Date.now() });
    res.json({ success: true });
});

// ====== OTOMASYON: sağlayıcı bakiyesi düşükse Telegram uyarısı ======
let lastBalanceAlert = 0;
async function notifyLowProviderBalance(text) {
    if (Date.now() - lastBalanceAlert < 600000) return; // en fazla 10 dakikada bir
    lastBalanceAlert = Date.now();
    try { await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_CHAT_ID, text }); } catch (e) {}
}

const PROVIDER_ERRORS = {
    NO_NUMBERS: 'Bu ürün için şu an numara kalmamış.',
    NO_BALANCE: 'Sağlayıcı hesabında bakiye yok (panel sahibi bakiye yüklemeli).',
    BAD_KEY: 'Sağlayıcı API anahtarı hatalı.',
    BAD_SERVICE: 'Servis kodu geçersiz.',
    WRONG_SERVICE: 'Servis kodu geçersiz.',
    BAD_COUNTRY: 'Ülke kodu geçersiz.',
    BANNED: 'Sağlayıcı API hesabı engellenmiş.',
    ERROR_SQL: 'Sağlayıcıda geçici hata, tekrar deneyin.'
};

// ====== NUMARA SATIN ALMA ======
// NOT: Önceki sürümdeki "daha pahalıya da olsa al" (freePrice/maxPrice) mantığı kaldırıldı.
// O mantık TL satış fiyatını sağlayıcının kendi para birimiyle karıştırıp bakiyeyi gerçekte
// aşan isteklere yol açıyor ve NO_BALANCE hatasının asıl sebebiydi. Artık sağlayıcıdan sadece
// kendi normal/en uygun fiyatından numara isteniyor; satış fiyatımız hep sabit kalıyor.
app.post('/api/buyNumber', async (req, res) => {
    const { productId, username } = req.body;
    const userObj = db.users[username];
    if (!userObj) return res.json({ success: false, message: "Kullanıcı bulunamadı." });

    const item = CATALOG.find(c => c.id === productId);
    if (!item) return res.json({ success: false, message: "Geçersiz ürün." });

    const price = item.price;
    if (userObj.balance < price) return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin." });

    const showDetail = userObj.role === 'admin';

    try {
        const candidates = await countryCandidates(item);
        let responseText = '';
        let usedCountry = candidates[0];
        let allRaw = [];

        const ATTEMPTS_PER_COUNTRY = 4; // stok anlık yenilenebiliyor, her ülkede birkaç kez dene
        outer:
        for (const country of candidates) {
            usedCountry = country;
            for (let attempt = 0; attempt < ATTEMPTS_PER_COUNTRY; attempt++) {
                const resp = await axios.get(ONAYLI_SMS_URL, {
                    params: { api_key: ONAYLI_SMS_API_KEY, action: 'getNumber', service: item.serviceCode, country: country },
                    timeout: 30000
                });
                responseText = resp.data;
                if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
                responseText = responseText ? String(responseText).trim() : '';
                allRaw.push(country + ':' + responseText);
                console.log('[getNumber] ' + item.id + ' country=' + country + ' deneme=' + (attempt + 1) + ' -> "' + responseText + '"');

                if (responseText.startsWith('ACCESS_NUMBER')) break outer;
                if (responseText.startsWith('NO_NUMBERS')) {
                    if (attempt < ATTEMPTS_PER_COUNTRY - 1) await new Promise(r => setTimeout(r, 1500));
                    continue;
                }
                break outer; // bakiye/anahtar gibi başka bir hata -> başka ülkeyi denemenin anlamı yok
            }
        }

        if (responseText.startsWith('ACCESS_NUMBER')) {
            const parts = responseText.split(':');
            const activationId = parts[1];
            const phoneNumber = parts.slice(2).join(':');
            userObj.balance -= price;
            const order = {
                activationId, productName: item.name, price, phoneNumber,
                code: "Bekleniyor...", status: 'waiting', username,
                time: new Date().toLocaleString('tr-TR'), createdAt: Date.now()
            };
            db.orders[activationId] = order;
            return res.json({ success: true, order });
        }

        const key = responseText.split(':')[0];
        if (key === 'NO_BALANCE') notifyLowProviderBalance('⚠️ OnaylaSMS bakiyen yetersiz! "' + item.name + '" için numara alınamadı.');
        let msg;
        if (showDetail) {
            msg = (PROVIDER_ERRORS[key] || ('Sağlayıcı yanıtı: ' + responseText)) + ' [denenen ülkeler: ' + allRaw.join(' | ') + ']';
        } else if (key === 'NO_NUMBERS') {
            msg = 'Bu ürün için şu an numara bulunamadı, otomatik tekrar deneniyor...';
        } else {
            msg = 'Şu an numara alınamıyor, lütfen daha sonra tekrar deneyin.';
        }
        return res.json({ success: false, message: msg, retryable: key === 'NO_NUMBERS' });
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
            activationId: o.activationId, phoneNumber: o.phoneNumber, productName: o.productName,
            status: o.status, code: o.code, remaining: Math.max(1, Math.floor((600000 - (now - o.createdAt)) / 1000))
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
        const resp = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'setStatus', status: 8, id: activationId }, timeout: 20000 });
        const text = String(resp.data || '').trim();
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
        const resp = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getStatus', id: activationId }, timeout: 20000 });
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

// ====== TELEGRAM WEBHOOK (ödeme onay/reddet + destek cevapları) ======
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
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: ADMIN_CHAT_ID, text: `➡️ ${username} kullanıcısına iletildi.`, reply_to_message_id: update.message.message_id });
            }
        }
        if (update.callback_query) {
            const cb = update.callback_query;
            const chatId = cb.message.chat.id;
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
            body { background: radial-gradient(ellipse at 50% 20%, #04130a 0%, #030a06 42%, #010302 100%); }
            #emberCanvas { position: fixed; inset: 0; z-index: 0; }
            #matrixCanvas { position: fixed; inset: 0; z-index: 0; opacity: .55; }
            .anka { background: linear-gradient(90deg,#eaffd6,#4ade80,#16a34a,#4ade80,#eaffd6); background-size: 300% auto; -webkit-background-clip: text; background-clip: text; color: transparent; animation: shimmer 4s linear infinite; }
            @keyframes shimmer { to { background-position: 300% center; } }
            .vipBadge { display: inline-block; margin-left: 8px; padding: 2px 10px; font-size: 11px; font-weight: 900; letter-spacing: 2px; color: #04170c; background: linear-gradient(90deg,#fde68a,#facc15,#fde68a); background-size: 200% auto; border-radius: 6px; animation: shine 3s linear infinite; vertical-align: middle; box-shadow: 0 0 12px rgba(74,222,128,.5); }
            @keyframes shine { to { background-position: 200% center; } }
            .glassCard { background: rgba(5,16,10,.55); border: 1px solid rgba(74,222,128,.28); box-shadow: 0 0 60px rgba(34,197,94,.12), inset 0 0 40px rgba(74,222,128,.04); backdrop-filter: blur(10px); }
            .ring { position: absolute; inset: -30px; border-radius: 50%; border: 1px solid rgba(74,222,128,.25); animation: spin 18s linear infinite; }
            .ring2 { position: absolute; inset: -60px; border-radius: 50%; border: 1px dashed rgba(250,204,21,.15); animation: spin 28s linear infinite reverse; }
            @keyframes spin { to { transform: rotate(360deg); } }
            .phoenixWrap { width: min(360px,78vw); margin: 0 auto; position: relative; }
            .phoenixWrap svg { width: 100%; height: auto; display: block; filter: drop-shadow(0 0 28px rgba(74,222,128,.65)); }
            .wingR { transform-origin: 0 0; animation: wingFlap 1.6s ease-in-out infinite; }
            @keyframes wingFlap { 0%,100% { transform: rotate(6deg); } 50% { transform: rotate(-10deg); } }
            .birdFloat { animation: floaty 3.2s ease-in-out infinite; }
            @keyframes floaty { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-14px); } }
            .tailE { transform-origin: 0 0; animation: tailSway 2.8s ease-in-out infinite alternate; }
            @keyframes tailSway { from { transform: rotate(-4deg); } to { transform: rotate(4deg); } }
            .spark { opacity: 0; animation: sparkUp 2.6s ease-in infinite; }
            @keyframes sparkUp { 0% { opacity: 0; transform: translateY(0); } 20% { opacity: 1; } 100% { opacity: 0; transform: translateY(-70px); } }
            .fadeUp { animation: fadeUp 1.1s ease both; }
            @keyframes fadeUp { from { opacity: 0; transform: translateY(26px) scale(.96); } to { opacity: 1; transform: none; } }
            .blink { animation: blink 1s steps(2) infinite; }
            @keyframes blink { 50% { opacity: 0; } }
            .vipCard { border: 1px solid rgba(250,204,21,.45) !important; }
            .bg-slate-900, .bg-slate-950 { background-color: rgba(4,12,8,.82) !important; }
            header { backdrop-filter: blur(6px); box-shadow: 0 0 30px rgba(34,197,94,.12); }
        </style>
    </head>
    <body class="text-slate-100 font-sans min-h-screen flex flex-col justify-between">
        <canvas id="emberCanvas"></canvas>
        <template id="phoenixTpl">
            <svg viewBox="-30 -10 460 440" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Anka kuşu">
            <defs>
                <linearGradient id="gFire" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff6cf"/><stop offset=".4" stop-color="#ffb23f"/><stop offset=".75" stop-color="#f1591c"/><stop offset="1" stop-color="#a81810"/></linearGradient>
                <linearGradient id="gWing" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff6cf"/><stop offset=".38" stop-color="#ffac34"/><stop offset=".72" stop-color="#ef4123"/><stop offset="1" stop-color="#7a1210"/></linearGradient>
                <linearGradient id="gTail" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd271"/><stop offset=".5" stop-color="#f0501f"/><stop offset="1" stop-color="#7f1d1d" stop-opacity="0"/></linearGradient>
                <radialGradient id="gGlow"><stop offset="0" stop-color="#ffb347" stop-opacity=".6"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>
                <radialGradient id="gEye" cx=".5" cy=".4" r=".65"><stop offset="0" stop-color="#fff6cf"/><stop offset=".55" stop-color="#ffb23f"/><stop offset="1" stop-color="#8a1a0c"/></radialGradient>
                <filter id="glowF" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
                <path id="ftW" d="M0 0 C34 -9 90 -16 150 -10 C140 -4 128 2 150 10 C112 11 86 18 150 32 C106 24 84 30 112 46 C78 38 60 40 56 50 C34 38 14 22 0 0 Z"/>
                <path id="ftT" d="M0 0 C-11 44 -9 102 0 152 C9 102 11 44 0 0 Z"/>
            </defs>
            <circle cx="200" cy="195" r="205" fill="url(#gGlow)"/>
            <g class="emberLayer">
                <circle class="ember" cx="88" cy="335" r="2.6" fill="#ffd271" style="animation-delay:.1s"/>
                <circle class="ember" cx="128" cy="378" r="2.1" fill="#ffac34" style="animation-delay:1.2s"/>
                <circle class="ember" cx="168" cy="350" r="2.8" fill="#fff3b0" style="animation-delay:2s"/>
                <circle class="ember" cx="212" cy="390" r="2.1" fill="#ffd271" style="animation-delay:.5s"/>
                <circle class="ember" cx="254" cy="348" r="2.6" fill="#ffac34" style="animation-delay:1.6s"/>
                <circle class="ember" cx="298" cy="380" r="2.3" fill="#fff3b0" style="animation-delay:.3s"/>
                <circle class="ember" cx="332" cy="322" r="2.2" fill="#ffd271" style="animation-delay:2.3s"/>
                <circle class="ember" cx="58" cy="258" r="2" fill="#ffac34" style="animation-delay:1.4s"/>
                <circle class="ember" cx="348" cy="250" r="2.4" fill="#fff3b0" style="animation-delay:.8s"/>
            </g>
            <g class="birdFloat" filter="url(#glowF)">
                <g transform="translate(200 230)"><g class="tailS">
                    <use href="#ftT" fill="url(#gTail)" transform="rotate(-42) scale(.7)"/>
                    <use href="#ftT" fill="url(#gTail)" transform="rotate(42) scale(.7)"/>
                    <use href="#ftT" fill="url(#gTail)" transform="rotate(-28) scale(.86)"/>
                    <use href="#ftT" fill="url(#gTail)" transform="rotate(28) scale(.86)"/>
                    <use href="#ftT" fill="url(#gTail)" transform="rotate(-14) scale(.97)"/>
                    <use href="#ftT" fill="url(#gTail)" transform="rotate(14) scale(.97)"/>
                    <use href="#ftT" fill="url(#gTail)" transform="rotate(0) scale(1.04)"/>
                </g></g>
                <g transform="translate(214 142)"><g class="flapR">
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".3" stroke-width="1.2" transform="rotate(-86) scale(.52)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".3" stroke-width="1.2" transform="rotate(-70) scale(.68)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".35" stroke-width="1.2" transform="rotate(-54) scale(.82)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".4" stroke-width="1.2" transform="rotate(-38) scale(.93)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".45" stroke-width="1.2" transform="rotate(-22) scale(1)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".4" stroke-width="1.2" transform="rotate(-6) scale(.97)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".35" stroke-width="1.2" transform="rotate(10) scale(.87)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".3" stroke-width="1.2" transform="rotate(25) scale(.7)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".3" stroke-width="1.2" transform="rotate(38) scale(.52)"/>
                </g></g>
                <g transform="translate(186 142) scale(-1 1)"><g class="flapR">
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".3" stroke-width="1.2" transform="rotate(-86) scale(.52)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".3" stroke-width="1.2" transform="rotate(-70) scale(.68)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".35" stroke-width="1.2" transform="rotate(-54) scale(.82)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".4" stroke-width="1.2" transform="rotate(-38) scale(.93)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".45" stroke-width="1.2" transform="rotate(-22) scale(1)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".4" stroke-width="1.2" transform="rotate(-6) scale(.97)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".35" stroke-width="1.2" transform="rotate(10) scale(.87)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".3" stroke-width="1.2" transform="rotate(25) scale(.7)"/>
                    <use href="#ftW" fill="url(#gWing)" stroke="#fff6cf" stroke-opacity=".3" stroke-width="1.2" transform="rotate(38) scale(.52)"/>
                </g></g>
                <path d="M200 106 C170 114 160 158 176 202 C185 228 193 240 200 250 C207 240 215 228 224 202 C240 158 230 114 200 106 Z" fill="url(#gFire)"/>
                <path d="M182 156 q18 14 36 0 M180 180 q20 15 40 0 M184 204 q16 13 32 0" fill="none" stroke="#fff6cf" stroke-opacity=".55" stroke-width="2" stroke-linecap="round"/>
                <path d="M200 106 C192 130 190 170 200 204" fill="none" stroke="#fff6cf" stroke-opacity=".4" stroke-width="1.6"/>
                <path d="M200 66 C188 42 204 26 196 -6 C217 22 215 46 208 66 Z" fill="#fff3b0"/>
                <path d="M187 74 C164 58 172 36 152 20 C182 30 196 50 196 74 Z" fill="#ffac34"/>
                <path d="M213 74 C236 58 228 36 248 20 C218 30 204 50 204 74 Z" fill="#ffac34"/>
                <path d="M200 84 C178 84 166 100 168 120 C170 140 184 154 200 156 C216 154 230 140 232 120 C234 100 222 84 200 84 Z" fill="url(#gFire)"/>
                <path d="M172 104 C170 96 176 88 184 86" fill="none" stroke="#fff6cf" stroke-opacity=".5" stroke-width="1.6"/>
                <path d="M190 116 L200 146 L210 116 C204 121 196 121 190 116 Z" fill="#ffd271" stroke="#7a1208" stroke-opacity=".35" stroke-width="1"/>
                <path d="M179 104 C182 98 192 97 197 102 C191 106 184 108 179 104 Z" fill="url(#gEye)"/>
                <path d="M221 104 C218 98 208 97 203 102 C209 106 216 108 221 104 Z" fill="url(#gEye)"/>
                <path d="M179 104 C182 100 189 99 193 102" fill="none" stroke="#2a0a02" stroke-opacity=".5" stroke-width="1"/>
                <path d="M221 104 C218 100 211 99 207 102" fill="none" stroke="#2a0a02" stroke-opacity=".5" stroke-width="1"/>
            </g>
            </svg>
        </template>

        <div id="intro" style="position:fixed;inset:0;z-index:100;background:radial-gradient(ellipse at 50% 35%,#1d0c04 0%,#070301 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;transition:opacity .9s ease;cursor:pointer" onclick="closeIntro()">
            <div class="ring"></div>
            <div class="ring2"></div>
            <div id="introPhoenix" class="phoenixWrap" style="width:min(260px,62vw)"></div>
            <h1 class="anka text-4xl md:text-5xl font-black tracking-widest mt-4">ANKA SMS</h1>
            <p class="text-amber-200/60 text-xs font-mono mt-1 tracking-widest">KÜLLERİNDEN DOĞAN GÜVENLİ SİSTEM</p>
            <div id="introLog" style="margin-top:22px;font-family:monospace;color:#fbbf24;font-size:13px;min-height:70px;text-align:center"></div>
            <div style="margin-top:10px;width:260px;height:3px;background:rgba(251,191,36,.15);border-radius:4px;overflow:hidden"><div id="introBar" style="height:100%;width:0;background:linear-gradient(90deg,#fde68a,#f59e0b);transition:width .6s ease;box-shadow:0 0 10px #f59e0b"></div></div>
            <p class="text-amber-200/30 text-[10px] mt-5">(geçmek için dokun)</p>
        </div>

        <div class="max-w-5xl mx-auto w-full p-4 relative z-10">
            <header class="flex justify-between items-center py-4 px-6 border border-amber-500/25 mb-6 rounded-2xl shadow-2xl">
                <div class="flex items-center gap-3">
                    <div class="bg-amber-500/15 p-2.5 rounded-xl border border-amber-500/40">
                        <i class="fa-solid fa-fire-flame-curved text-xl" style="color:#f97316;text-shadow:0 0 14px #f97316"></i>
                    </div>
                    <div>
                        <h1 class="anka text-2xl font-black tracking-widest inline-block">ANKA SMS</h1><span class="vipBadge">VIP</span>
                        <p class="text-[10px] text-amber-300/60 font-mono">GÜVENLİ SANAL NUMARA SİSTEMİ</p>
                    </div>
                </div>
                <div id="userArea" class="flex items-center gap-4"></div>
            </header>
            <main id="mainContent"></main>
        </div>

        <div id="authModal" class="fixed inset-0 bg-black/85 flex items-center justify-center hidden z-50">
            <div class="glassCard p-8 rounded-3xl w-full max-w-md relative shadow-2xl">
                <button onclick="closeAuthModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
                <div class="text-center mb-6"><h2 id="authTitle" class="text-2xl font-black text-white">Giriş Yap</h2></div>
                <div class="space-y-4">
                    <input type="text" id="authUsername" placeholder="Kullanıcı Adı" class="w-full bg-black/40 border border-amber-500/20 rounded-xl p-3 text-white focus:border-amber-500">
                    <input type="password" id="authPassword" placeholder="Şifre" class="w-full bg-black/40 border border-amber-500/20 rounded-xl p-3 text-white focus:border-amber-500">
                    <button onclick="handleAuthSubmit()" id="authSubmitBtn" class="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold py-3 rounded-xl transition">Giriş Yap</button>
                    <p class="text-center text-sm text-slate-400"><span onclick="switchAuthMode()" id="switchText" class="text-amber-400 cursor-pointer underline">Kayıt Ol</span></p>
                </div>
            </div>
        </div>

        <div id="depositModal" class="fixed inset-0 bg-black/85 flex items-center justify-center hidden z-50">
            <div class="glassCard p-8 rounded-3xl w-full max-w-md relative shadow-2xl">
                <button onclick="closeDeposit()" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
                <h2 class="text-xl font-black mb-4 text-amber-400"><i class="fa-solid fa-wallet"></i> Bakiye Yükle (IBAN)</h2>
                <div class="space-y-4 text-sm text-slate-300">
                    <div class="bg-black/40 p-4 rounded-xl border border-amber-500/20">
                        <p class="text-slate-500 text-xs">Banka IBAN:</p>
                        <p class="font-mono text-amber-400 font-bold text-base select-all">TR62 0006 2000 5000 0006 8107 73</p>
                        <p class="text-slate-500 text-xs mt-2">Alıcı:</p>
                        <p class="font-bold text-white text-base">Resul Sakal</p>
                    </div>
                    <input type="text" id="depositSender" placeholder="Gönderen Ad Soyad" class="w-full bg-black/40 border border-amber-500/20 rounded-xl p-3 text-white">
                    <input type="number" id="depositAmount" placeholder="Tutar (TL)" class="w-full bg-black/40 border border-amber-500/20 rounded-xl p-3 text-white">
                    <button onclick="submitDeposit()" class="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold py-3 rounded-xl">Bildirim Gönder</button>
                </div>
            </div>
        </div>

        <div id="supportBubble" onclick="toggleSupport()" style="position:fixed;bottom:22px;right:22px;z-index:60;width:58px;height:58px;border-radius:50%;background:linear-gradient(135deg,#f59e0b,#ef4444);display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 0 22px rgba(249,115,22,.55)">
            <i class="fa-solid fa-headset text-white text-xl"></i>
        </div>
        <div id="supportWindow" class="hidden" style="position:fixed;bottom:90px;right:22px;z-index:60;width:320px;max-width:88vw;height:440px;background:rgba(10,5,3,.97);border:1px solid rgba(249,115,22,.4);border-radius:18px;box-shadow:0 0 40px rgba(0,0,0,.6);display:flex;flex-direction:column;overflow:hidden">
            <div style="padding:12px 14px;border-bottom:1px solid rgba(249,115,22,.25)">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <span class="anka" style="font-weight:900;font-size:14px">CANLI DESTEK</span>
                    <i class="fa-solid fa-xmark" style="cursor:pointer;color:#94a3b8;padding:6px;font-size:16px" onclick="closeSupportWindow()"></i>
                </div>
                <a id="supportContactLink" href="#" target="_blank" style="font-size:11px;color:#fbbf24;text-decoration:none;display:block">Telegram: @...</a>
                <a id="supportContactWA" href="#" target="_blank" style="font-size:11px;color:#4ade80;text-decoration:none;display:block;margin-top:2px"><i class="fa-brands fa-whatsapp"></i> WhatsApp ile yaz</a>
            </div>
            <div id="supportMsgs" style="flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;font-size:13px"></div>
            <div style="padding:10px;border-top:1px solid rgba(249,115,22,.25);display:flex;gap:6px">
                <input id="supportInput" onkeydown="if(event.key==='Enter')sendSupport()" placeholder="Mesajınızı yazın..." style="flex:1;background:#140a06;border:1px solid #2a180c;border-radius:10px;padding:8px 10px;color:#e2e8f0;font-size:13px">
                <button onclick="sendSupport()" style="background:#f59e0b;color:#1a1000;border-radius:10px;padding:0 14px;font-weight:800">Gönder</button>
            </div>
        </div>

        <script>
            var currentUser = localStorage.getItem('currentUser') || null;
            var currentRole = localStorage.getItem('currentRole') || 'user';
            var isRegisterMode = false;
            var orderTimers = {};
            var supportOpen = false, supportTimer = null;
            var phoenixCount = 0;

            (function () {
                var c = document.getElementById('emberCanvas');
                var ctx = c.getContext('2d');
                var parts = [];
                function resize() { c.width = window.innerWidth; c.height = window.innerHeight; }
                resize();
                window.addEventListener('resize', resize);
                function spawn() {
                    if (parts.length > 140) return;
                    parts.push({ x: Math.random() * c.width, y: c.height + 10, r: 1 + Math.random() * 2.4, vy: .4 + Math.random() * .9, vx: (Math.random() - .5) * .5, a: 0, life: 0, max: 160 + Math.random() * 160, hue: Math.random() > .5 ? '255,178,63' : '253,224,71' });
                }
                setInterval(spawn, 90);
                function tick() {
                    ctx.clearRect(0, 0, c.width, c.height);
                    for (var i = parts.length - 1; i >= 0; i--) {
                        var p = parts[i];
                        p.life++; p.y -= p.vy; p.x += p.vx + Math.sin(p.life * .05) * .3;
                        p.a = Math.sin((p.life / p.max) * Math.PI);
                        ctx.beginPath(); ctx.fillStyle = 'rgba(' + p.hue + ',' + (p.a * .85) + ')'; ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
                        if (p.life > p.max) parts.splice(i, 1);
                    }
                    requestAnimationFrame(tick);
                }
                tick();
            })();

            function phoenixHTML() {
                var t = document.getElementById('phoenixTpl');
                if (!t) return '';
                phoenixCount++;
                return t.innerHTML.replace(/(gFire|gWing|gTail|gGlow|gEye|glowF|ftW|ftT)/g, '$1_' + phoenixCount);
            }

            var introClosed = false;
            function closeIntro() {
                if (introClosed) return;
                introClosed = true;
                var o = document.getElementById('intro');
                if (!o) return;
                o.style.opacity = '0';
                setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); }, 900);
            }
            function runIntro() {
                var ip = document.getElementById('introPhoenix');
                if (ip) ip.innerHTML = phoenixHTML();
                var lines = ['> sistem başlatılıyor...', '> şifreli bağlantı kuruluyor...', '> sunucu doğrulandı [OK]', '> anka külllerinden doğuyor...', '> erişim sağlandı'];
                var log = document.getElementById('introLog');
                var bar = document.getElementById('introBar');
                lines.forEach(function (t, i) {
                    setTimeout(function () {
                        if (introClosed) return;
                        var d = document.createElement('div'); d.textContent = t; log.appendChild(d);
                        bar.style.width = ((i + 1) * 20) + '%';
                    }, 450 + i * 620);
                });
                setTimeout(function () { closeIntro(); }, 3900);
            }
            if (sessionStorage.getItem('introDone')) {
                var introEl = document.getElementById('intro');
                if (introEl) introEl.parentNode.removeChild(introEl);
                introClosed = true;
            } else {
                runIntro();
                sessionStorage.setItem('introDone', '1');
            }

            function init() {
                updateUserArea();
                if (currentUser) {
                    buildMain();
                    loadServices();
                    restoreOrders();
                }
            }

            function updateUserArea() {
                var area = document.getElementById('userArea');
                if (currentUser) {
                    area.innerHTML =
                        '<div class="flex items-center gap-3">' +
                        '<span class="text-sm font-medium">@<strong class="text-white">' + currentUser + '</strong></span>' +
                        '<span id="userBalance" class="bg-amber-500/10 text-amber-300 px-3.5 py-1.5 rounded-full text-xs font-bold border border-amber-500/30">0.00 TL</span>' +
                        (currentRole === 'admin' ? '<button onclick="openAdminPanel()" class="bg-amber-600 hover:bg-amber-500 px-3.5 py-1.5 rounded-xl text-xs font-bold">Admin Panel</button>' : '') +
                        '<button onclick="logout()" class="text-red-400 text-sm p-2"><i class="fa-solid fa-right-from-bracket"></i></button>' +
                        '</div>';
                    fetchBalance();
                } else {
                    area.innerHTML =
                        '<button onclick="openAuthModal(\\'login\\')" class="bg-amber-600 hover:bg-amber-500 px-5 py-2.5 rounded-xl text-sm font-bold">Giriş Yap</button>' +
                        '<button onclick="openAuthModal(\\'register\\')" class="bg-black/40 border border-amber-500/30 px-5 py-2.5 rounded-xl text-sm font-bold">Kayıt Ol</button>';
                    document.getElementById('mainContent').innerHTML =
                        '<div class="text-center py-16 glassCard vipCard rounded-3xl p-8 fadeUp">' +
                        '<div class="phoenixWrap">' + phoenixHTML() + '</div>' +
                        '<div class="mb-3 mt-2"><span class="vipBadge">VIP ÜYELİK PANELİ</span></div>' +
                        '<h2 class="anka text-5xl md:text-6xl font-black mb-4 font-mono tracking-widest">ANKA SMS</h2>' +
                        '<p class="text-amber-200/70 font-mono mb-8">Anlık sanal numara &bull; Hızlı SMS kodu &bull; 7/24 aktif<span class="blink">_</span></p>' +
                        '<div class="flex gap-3 justify-center"><button onclick="openAuthModal(\\'login\\')" class="bg-amber-600 hover:bg-amber-500 px-8 py-3 rounded-xl font-bold">Giriş Yap</button>' +
                        '<button onclick="openAuthModal(\\'register\\')" class="bg-black/40 border border-amber-500/40 hover:bg-amber-900/30 px-8 py-3 rounded-xl font-bold text-amber-300">Kayıt Ol</button></div>' +
                        '<p class="text-amber-200/40 text-xs mt-6">Destek: Telegram <a href="https://t.me/vipankaa" target="_blank" class="text-amber-400 underline">@vipankaa</a> &bull; WhatsApp <a href="https://wa.me/573181006792" target="_blank" class="text-emerald-400 underline">+57 318 100 6792</a></p>' +
                        '</div>';
                }
            }

            async function fetchBalance() {
                if (!currentUser) return;
                var res = await fetch('/api/getCustomerBalance?username=' + encodeURIComponent(currentUser));
                var data = await res.json();
                var el = document.getElementById('userBalance');
                if (data.success && el) el.innerText = data.balance.toFixed(2) + ' TL';
            }

            function buildMain() {
                document.getElementById('mainContent').innerHTML =
                    '<div id="servicesGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4"><p class="text-slate-400 text-sm">Yükleniyor...</p></div>' +
                    '<div class="mt-6 flex justify-end"><button onclick="openDeposit()" class="bg-amber-600 hover:bg-amber-500 px-6 py-3 rounded-xl font-bold text-sm"><i class="fa-solid fa-wallet mr-2"></i> Bakiye Yükle</button></div>' +
                    '<div id="activeOrderArea" class="mt-8"></div>';
            }

            function openDeposit() { document.getElementById('depositModal').classList.remove('hidden'); }
            function closeDeposit() { document.getElementById('depositModal').classList.add('hidden'); }

            async function loadServices() {
                if (!currentUser) return;
                var grid = document.getElementById('servicesGrid');
                if (!grid) return;
                try {
                    var res = await fetch('/api/getServices');
                    var data = await res.json();
                    if (!data.success || !data.services.length) {
                        grid.innerHTML = '<p class="text-slate-400 text-sm">Şu an ürün yüklenemedi.</p>';
                        return;
                    }
                    grid.innerHTML = data.services.map(renderServiceCard).join('');
                } catch (e) {}
            }

            function renderServiceCard(s) {
                return '<div class="bg-black/40 border border-amber-500/15 p-5 rounded-2xl flex items-center justify-between shadow-xl hover:border-amber-500/50 transition">' +
                    '<div class="flex items-center gap-4">' +
                    '<div class="' + s.bg + ' ' + s.color + ' w-12 h-12 rounded-xl flex items-center justify-center text-xl border border-amber-500/15"><i class="fa-brands ' + s.icon + '"></i></div>' +
                    '<div><h3 class="font-bold text-sm text-white">' + s.name + '</h3>' +
                    '<p class="text-amber-300 font-bold text-sm">' + s.price.toFixed(2) + ' TL</p></div>' +
                    '</div>' +
                    '<button data-id="' + s.id + '" onclick="buyNumber(this)" class="bg-amber-600 hover:bg-amber-500 px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg transition">Numara Al</button>' +
                    '</div>';
            }

            var MAX_AUTO_RETRY = 6;
            async function buyNumber(btn, attemptNo) {
                attemptNo = attemptNo || 1;
                var productId = btn.getAttribute('data-id');
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> ' + (attemptNo > 1 ? 'Tekrar deneniyor (' + attemptNo + '/' + (MAX_AUTO_RETRY + 1) + ')...' : 'Alınıyor...');
                try {
                    var res = await fetch('/api/buyNumber', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productId: productId, username: currentUser }) });
                    var data = await res.json();
                    if (data.success) {
                        btn.disabled = false;
                        btn.innerText = 'Numara Al';
                        fetchBalance();
                        trackOrder(data.order.activationId, data.order.phoneNumber, 600, data.order.productName, null);
                    } else if (data.retryable && attemptNo <= MAX_AUTO_RETRY) {
                        setTimeout(function () { buyNumber(btn, attemptNo + 1); }, 2500);
                    } else {
                        btn.disabled = false;
                        btn.innerText = 'Numara Al';
                        alert(data.message);
                    }
                } catch (e) {
                    btn.disabled = false;
                    btn.innerText = 'Numara Al';
                    alert('Bağlantı hatası, tekrar deneyin.');
                }
            }

            function trackOrder(id, phone, timeLeft, productName, doneCode) {
                var area = document.getElementById('activeOrderArea');
                if (!area) return;
                var old = document.getElementById('order_' + id);
                if (old) old.parentNode.removeChild(old);
                if (orderTimers[id]) { clearInterval(orderTimers[id]); delete orderTimers[id]; }
                var done = !!doneCode;

                var card = document.createElement('div');
                card.id = 'order_' + id;
                card.className = 'bg-black/40 border border-amber-500 p-6 rounded-2xl shadow-2xl relative mb-4';
                card.innerHTML =
                    '<h3 class="font-bold text-amber-400 text-lg mb-3"><i class="fa-solid fa-circle-check mr-2"></i> ' + (productName || 'Numara') + '</h3>' +
                    '<p class="text-sm text-slate-300">Numara: <strong class="text-white font-mono text-xl select-all">' + phone + '</strong></p>' +
                    '<p class="text-sm text-slate-300 mt-2">SMS Kod: <strong id="smsCode_' + id + '" class="text-amber-400 font-mono text-xl ' + (done ? '' : 'animate-pulse') + '">' + (done ? doneCode : 'Bekleniyor...') + '</strong></p>' +
                    '<div class="mt-4 flex items-center justify-between border-t border-amber-500/20 pt-4">' +
                    '<span class="text-xs text-slate-400">' + (done ? '' : 'Kod Süresi: <strong id="timerDisplay_' + id + '" class="text-amber-400 font-mono text-sm">--:--</strong>') + '</span>' +
                    '<div id="actionButtons_' + id + '">' + (done
                        ? '<span class="text-amber-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>'
                        : '<button data-id="' + id + '" onclick="cancelBtn(this)" class="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-500/40 px-4 py-2 rounded-xl text-xs font-bold transition">Değiştir / İptal Et</button>') +
                    '</div></div>';
                area.insertBefore(card, area.firstChild);
                if (done) return;

                var tick = 0;
                orderTimers[id] = setInterval(async function () {
                    timeLeft--; tick++;
                    var min = Math.floor(timeLeft / 60), sec = timeLeft % 60;
                    var timerEl = document.getElementById('timerDisplay_' + id);
                    if (timerEl) timerEl.innerText = String(Math.max(min, 0)).padStart(2, '0') + ':' + String(Math.max(sec, 0)).padStart(2, '0');
                    if (timeLeft <= 0) { clearInterval(orderTimers[id]); delete orderTimers[id]; cancelOrder(id, true); return; }
                    if (tick % 5 !== 0) return;
                    try {
                        var res = await fetch('/api/checkSms/' + id);
                        var data = await res.json();
                        if (data.success && data.status === 'completed') {
                            clearInterval(orderTimers[id]); delete orderTimers[id];
                            var codeEl = document.getElementById('smsCode_' + id);
                            if (codeEl) { codeEl.innerText = data.code; codeEl.classList.remove('animate-pulse'); }
                            var actionArea = document.getElementById('actionButtons_' + id);
                            if (actionArea) actionArea.innerHTML = '<span class="text-amber-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>';
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
                var res = await fetch('/api/cancelNumber', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ activationId: id, username: currentUser }) });
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
            function openLogin() { openAuthModal('login'); }
            function openRegister() { openAuthModal('register'); }

            async function handleAuthSubmit() {
                var username = document.getElementById('authUsername').value;
                var password = document.getElementById('authPassword').value;
                var endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
                var res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: username, password: password }) });
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
                var res = await fetch('/api/deposit/notify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: currentUser, senderName: senderName, amount: amount }) });
                var data = await res.json();
                alert(data.message);
                closeDeposit();
            }

            function toggleSupport() {
                if (!currentUser) { openAuthModal('login'); return; }
                if (supportOpen) { closeSupportWindow(); return; }
                supportOpen = true;
                document.getElementById('supportWindow').classList.remove('hidden');
                loadSupport();
                if (supportTimer) clearInterval(supportTimer);
                supportTimer = setInterval(loadSupport, 4000);
            }
            function closeSupportWindow() {
                supportOpen = false;
                document.getElementById('supportWindow').classList.add('hidden');
                if (supportTimer) { clearInterval(supportTimer); supportTimer = null; }
            }
            function renderSupportMsg(m) {
                var mine = m.from === 'user';
                return '<div style="align-self:' + (mine ? 'flex-end' : 'flex-start') + ';max-width:80%;background:' + (mine ? 'rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.35)' : 'rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)') + ';color:#e2e8f0;padding:7px 10px;border-radius:10px">' +
                    '<div>' + m.text.replace(/</g, '&lt;') + '</div><div style="font-size:10px;color:#64748b;margin-top:2px">' + m.time + '</div></div>';
            }
            async function loadSupport() {
                try {
                    var res = await fetch('/api/support/messages?username=' + encodeURIComponent(currentUser));
                    var data = await res.json();
                    if (!data.success) return;
                    var link = document.getElementById('supportContactLink');
                    if (link && data.contact) { link.textContent = 'Telegram: @' + data.contact; link.href = 'https://t.me/' + data.contact; }
                    var wa = document.getElementById('supportContactWA');
                    if (wa && data.whatsapp) wa.href = 'https://wa.me/' + data.whatsapp;
                    var box = document.getElementById('supportMsgs');
                    if (!box) return;
                    box.innerHTML = data.messages.map(renderSupportMsg).join('') || '<p style="color:#64748b;font-size:12px">Bir sorun mu var? Buradan yaz, en kısa sürede Telegram üzerinden dönüş yapılır.</p>';
                    box.scrollTop = box.scrollHeight;
                } catch (e) {}
            }
            async function sendSupport() {
                var inp = document.getElementById('supportInput');
                var text = inp.value.trim();
                if (!text || !currentUser) return;
                inp.value = '';
                await fetch('/api/support/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: currentUser, text: text }) });
                loadSupport();
            }

            async function openAdminPanel() {
                var res = await fetch('/api/admin/getData?adminUsername=' + encodeURIComponent(currentUser));
                var data = await res.json();
                if (!data.success) return alert('Yetkisiz!');

                var pendingHtml = '';
                data.payments.filter(function (p) { return p.status === 'pending'; }).forEach(function (p) {
                    pendingHtml += '<div class="bg-black/40 p-4 rounded-xl mb-2 flex justify-between items-center"><span>' + p.username + ' - ' + p.amount + ' TL (' + p.senderName + ') <span class="text-slate-500 text-xs">' + p.time + '</span></span><div>' +
                        '<button onclick="processPay(\\'' + p.id + '\\',\\'approve\\')" class="bg-emerald-600 px-3 py-1 rounded text-xs font-bold mr-1">Onayla</button>' +
                        '<button onclick="processPay(\\'' + p.id + '\\',\\'reject\\')" class="bg-red-600 px-3 py-1 rounded text-xs font-bold">Reddet</button></div></div>';
                });
                if (!pendingHtml) pendingHtml = '<p class="text-sm text-slate-500">Bekleyen ödeme yok.</p>';

                var allPayHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.payments.map(function (p) {
                    var c = p.status === 'approved' ? 'text-emerald-400' : (p.status === 'rejected' ? 'text-red-400' : 'text-amber-400');
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex justify-between"><span>' + p.username + '</span><span>' + p.amount + ' TL</span><span class="' + c + '">' + p.status + '</span><span class="text-slate-500">' + p.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.payments.length) allPayHtml = '<p class="text-sm text-slate-500">Henüz ödeme yok.</p>';

                var usersHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.users.map(function (u) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex justify-between"><span class="font-bold text-white">' + u.username + '</span><span>' + u.balance.toFixed(2) + ' TL</span><span class="text-slate-500">' + u.role + '</span><span class="text-slate-500">' + u.registeredAt + '</span></div>';
                }).join('') + '</div>';

                var loginsHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.logins.map(function (l) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex justify-between"><span class="font-bold text-white">' + l.username + '</span><span class="text-slate-400 font-mono">' + l.ip + '</span><span class="text-slate-500">' + l.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.logins.length) loginsHtml = '<p class="text-sm text-slate-500">Henüz giriş kaydı yok.</p>';

                var ordersHtml = '<div class="max-h-56 overflow-y-auto space-y-1">' + data.orders.map(function (o) {
                    return '<div class="bg-black/30 px-3 py-2 rounded-lg text-xs flex justify-between"><span class="font-bold text-white">' + o.username + '</span><span>' + o.productName + '</span><span class="font-mono">' + o.phoneNumber + '</span><span class="text-slate-500">' + o.status + '</span><span class="text-slate-500">' + o.time + '</span></div>';
                }).join('') + '</div>';
                if (!data.orders.length) ordersHtml = '<p class="text-sm text-slate-500">Henüz sipariş yok.</p>';

                var supportHtml = '<div class="space-y-2">' + data.supportChats.map(function (c) {
                    return '<div class="bg-black/30 p-3 rounded-lg text-xs"><div class="flex justify-between mb-1"><span class="font-bold text-white">' + c.username + '</span><span class="text-slate-500">' + (c.last ? c.last.time : '') + '</span></div>' +
                        '<div class="text-slate-400 mb-2">' + (c.last ? c.last.text.replace(/</g, '&lt;') : '') + '</div>' +
                        '<div class="flex gap-1"><input id="adminReply_' + c.username + '" placeholder="Cevap yaz..." class="flex-1 bg-black/40 border border-amber-500/20 rounded px-2 py-1 text-xs text-white">' +
                        '<button onclick="adminReplySupport(\\'' + c.username + '\\')" class="bg-amber-600 px-3 rounded text-xs font-bold">Gönder</button></div></div>';
                }).join('') + '</div>';
                if (!data.supportChats.length) supportHtml = '<p class="text-sm text-slate-500">Henüz destek mesajı yok.</p>';

                document.getElementById('mainContent').innerHTML =
                    '<div class="glassCard p-6 rounded-2xl space-y-6">' +
                    '<div class="flex justify-between items-center"><h2 class="text-xl font-bold text-amber-400">Admin Paneli</h2><button onclick="location.reload();" class="bg-black/40 border border-amber-500/30 px-4 py-2 rounded-xl text-xs font-bold">Geri Dön</button></div>' +
                    '<div><h3 class="font-bold mb-2 text-amber-300"><i class="fa-solid fa-money-bill-wave mr-1"></i> Bekleyen Ödemeler</h3>' + pendingHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-amber-300"><i class="fa-solid fa-receipt mr-1"></i> Tüm Ödemeler (kim ödeme yapmış)</h3>' + allPayHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-amber-300"><i class="fa-solid fa-users mr-1"></i> Kayıtlı Kullanıcılar</h3>' + usersHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-amber-300"><i class="fa-solid fa-right-to-bracket mr-1"></i> Giriş Yapanlar (kullanıcı / IP / zaman)</h3>' + loginsHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-amber-300"><i class="fa-solid fa-sim-card mr-1"></i> Son Siparişler</h3>' + ordersHtml + '</div>' +
                    '<div><h3 class="font-bold mb-2 text-amber-300"><i class="fa-solid fa-headset mr-1"></i> Destek Sohbetleri</h3>' + supportHtml + '</div>' +
                    '<div><a href="/api/admin/testApi?adminUsername=' + encodeURIComponent(currentUser) + '" target="_blank" class="inline-block bg-blue-600 px-4 py-2 rounded-xl text-xs font-bold text-white">Sağlayıcı Bağlantı / Bakiye Testi (JSON)</a></div>' +
                    '</div>';
            }

            async function adminReplySupport(username) {
                var inp = document.getElementById('adminReply_' + username);
                var text = inp.value.trim();
                if (!text) return;
                await fetch('/api/admin/support/reply', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminUsername: currentUser, username: username, text: text }) });
                openAdminPanel();
            }

            async function processPay(paymentId, action) {
                await fetch('/api/admin/processPayment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminUsername: currentUser, paymentId: paymentId, action: action }) });
                openAdminPanel();
            }

            function logout() {
                Object.keys(orderTimers).forEach(function (id) { clearInterval(orderTimers[id]); });
                orderTimers = {};
                if (supportTimer) { clearInterval(supportTimer); supportTimer = null; }
                var sw = document.getElementById('supportWindow'); if (sw) sw.classList.add('hidden');
                supportOpen = false;
                localStorage.clear();
                currentUser = null;
                currentRole = 'user';
                init();
            }
            window.onload = init;
        </script>
    </body>
    </html>
    `);
});

// Süresi dolan ya da yarım kalan siparişleri sunucu kendisi temizler (kullanıcı sayfayı kapatsa bile)
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

// Sağlayıcı bakiyesi düşükse 15 dakikada bir otomatik kontrol + Telegram uyarısı
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    if (!ONAYLI_SMS_API_KEY) console.warn('UYARI: ONAYLI_SMS_API_KEY ayarlanmamış!');
    try {
        const webhookUrl = `${RENDER_EXTERNAL_URL}${webhookPath}`;
        await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    } catch (err) {}
});
