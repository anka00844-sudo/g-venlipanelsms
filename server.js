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

let db = {
    users: {
        "Aklomanti": { username: "Aklomanti", password: "Aklomanti", balance: 5000, role: "admin" }
    },
    payments: {},
    visitors: [],
    logins: [],
    orders: {}
};

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

// ====== SERVİS LİSTESİ (CANLI) ======
app.get('/api/getServices', async (req, res) => {
    try {
        const q = (req.query.q || '').toString().toLowerCase().trim();
        const data = await getProviderPrices();
        let list = [];

        for (const countryId in data) {
            const countryServices = data[countryId];
            if (!countryServices || typeof countryServices !== 'object') continue;

            for (const serviceCode in countryServices) {
                if (!/^[a-zA-Z0-9_]+$/.test(serviceCode)) continue;
                const { count, cost } = readInfo(countryServices[serviceCode]);
                if (count <= 0 || cost <= 0) continue; // sadece GERÇEKTEN stokta olanlar

                const code = serviceCode.toLowerCase();
                const meta = SERVICE_INFO[code];
                const baseName = meta ? meta.name : serviceCode.toUpperCase();
                const countryName = COUNTRY_NAMES[String(countryId)] || ('Ülke ' + countryId);
                const fullName = baseName + ' (' + countryName + ')';

                // Arama yoksa sadece popüler servisleri göster, arama varsa hepsinde ara
                if (q) {
                    if (!fullName.toLowerCase().includes(q) && !code.includes(q)) continue;
                } else if (!meta) continue;

                list.push({
                    id: serviceCode + '_' + countryId,
                    name: fullName,
                    price: calcPrice(cost),
                    serviceCode: serviceCode,
                    country: String(countryId),
                    stock: count,
                    icon: meta ? meta.icon : 'fa-globe',
                    iconType: meta ? meta.type : 'fa-solid',
                    color: meta ? meta.color : 'text-emerald-400',
                    bg: meta ? meta.bg : 'bg-emerald-500/10',
                    _pop: meta ? POPULAR.indexOf(code) : 99
                });
            }
        }

        list.sort((a, b) => a._pop - b._pop || a.price - b.price);
        list = list.slice(0, 60).map(({ _pop, ...rest }) => rest);

        res.json({ success: true, services: list });
    } catch (e) {
        console.error('getServices hatası:', e.message);
        res.json({ success: false, services: [], message: e.message });
    }
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
        db.logins.unshift({ username, ip, time: new Date().toLocaleString('tr-TR') });
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

// Sağlayıcı bağlantı testi: sağlayıcı bakiyesi + ham fiyat verisinin özeti
app.get('/api/admin/testApi', async (req, res) => {
    if (!isAdmin(req.query.adminUsername)) return res.status(403).json({ success: false, message: "Yetkisiz." });
    try {
        const balResp = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getBalance' }, timeout: 20000 });
        const data = await getProviderPrices(true);
        const countries = Object.keys(data);
        res.json({
            success: true,
            providerBalance: balResp.data,
            countryCount: countries.length,
            sample: { [countries[0]]: data[countries[0]] }
        });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// ====== NUMARA SATIN ALMA ======
const PROVIDER_ERRORS = {
    NO_NUMBERS: 'Bu servis için şu an numara kalmamış. Başka ülke/servis deneyin.',
    NO_BALANCE: 'Sağlayıcı hesabında bakiye yok (panel sahibi bakiye yüklemeli).',
    BAD_KEY: 'Sağlayıcı API anahtarı hatalı.',
    BAD_SERVICE: 'Servis kodu geçersiz.',
    WRONG_SERVICE: 'Servis kodu geçersiz.',
    BAD_COUNTRY: 'Ülke kodu geçersiz.',
    BANNED: 'Sağlayıcı API hesabı engellenmiş.',
    ERROR_SQL: 'Sağlayıcıda geçici hata, tekrar deneyin.'
};

app.post('/api/buyNumber', async (req, res) => {
    const { serviceCode, country, username } = req.body;
    const userObj = db.users[username];
    if (!userObj) return res.json({ success: false, message: "Kullanıcı bulunamadı." });

    try {
        // FİYAT İSTEMCİDEN DEĞİL, SUNUCUDAN ALINIR (müşteri fiyatı değiştiremesin)
        const prices = await getProviderPrices();
        const { count, cost } = readInfo(prices[country] && prices[country][serviceCode]);
        if (count <= 0 || cost <= 0) return res.json({ success: false, message: "Bu servis şu an stokta yok." });

        const price = calcPrice(cost);
        if (userObj.balance < price) return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin." });

        const resp = await axios.get(ONAYLI_SMS_URL, {
            params: { api_key: ONAYLI_SMS_API_KEY, action: 'getNumber', service: serviceCode, country: country },
            timeout: 30000
        });
        let responseText = resp.data;
        if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
        responseText = responseText ? String(responseText).trim() : '';
        console.log(`[getNumber] service=${serviceCode} country=${country} -> "${responseText}"`);

        if (responseText.startsWith('ACCESS_NUMBER')) {
            const parts = responseText.split(':');
            const activationId = parts[1];
            const phoneNumber = parts.slice(2).join(':');

            userObj.balance -= price;

            const order = {
                activationId,
                productName: (SERVICE_INFO[serviceCode.toLowerCase()] || {}).name || serviceCode.toUpperCase(),
                price,
                phoneNumber,
                code: "Bekleniyor...",
                status: 'waiting',
                username,
                time: new Date().toLocaleString('tr-TR')
            };
            db.orders[activationId] = order;
            return res.json({ success: true, order });
        }

        const key = responseText.split(':')[0];
        const msg = PROVIDER_ERRORS[key] || ('Sağlayıcı yanıtı: ' + responseText);
        pricesCache.time = 0; // stok değişmiş olabilir, listeyi yenile
        return res.json({ success: false, message: msg });
    } catch (error) {
        console.error("API Bağlantı Hatası:", error.message);
        return res.json({ success: false, message: "Sağlayıcı bağlantı hatası: " + error.message });
    }
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

// ====== TELEGRAM WEBHOOK (onayla/reddet butonları) ======
const webhookPath = `/api/telegram-webhook-${TELEGRAM_BOT_TOKEN}`;
app.post(webhookPath, async (req, res) => {
    const update = req.body;
    try {
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
        <title>VIP SMS Onay Paneli</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="bg-slate-950 text-slate-100 font-sans min-h-screen flex flex-col justify-between">
        <div class="max-w-5xl mx-auto w-full p-4">
            <header class="flex justify-between items-center py-4 px-6 border border-emerald-500/30 mb-6 bg-slate-900/80 rounded-2xl shadow-2xl">
                <div class="flex items-center gap-3">
                    <div class="bg-emerald-500/20 text-emerald-400 p-2.5 rounded-xl border border-emerald-500/40">
                        <i class="fa-solid fa-crown text-xl"></i>
                    </div>
                    <div>
                        <h1 class="text-xl font-black tracking-wider text-emerald-400">VIP SMS ONAY</h1>
                        <p class="text-[10px] text-emerald-500/80 font-mono">CANLI STOK (20 SANİYEDE BİR GÜNCELLENİR)</p>
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
                    if (stockRefreshInterval) clearInterval(stockRefreshInterval);
                    stockRefreshInterval = setInterval(loadServices, 20000);
                }
            }

            function buildMain() {
                document.getElementById('mainContent').innerHTML =
                    '<input type="text" id="serviceSearch" oninput="onSearch()" placeholder="Servis veya ülke ara (örn: whatsapp, telegram, türkiye)" class="w-full bg-slate-900 border border-slate-800 rounded-xl p-3 text-white mb-4 focus:border-emerald-500">' +
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
                        '<div class="text-center py-20 bg-slate-900/70 rounded-3xl border border-emerald-500/20 p-8"><h2 class="text-3xl font-black mb-4 text-emerald-400">VIP SMS Onay Paneli</h2><p class="text-slate-400 mb-6">Devam etmek için giriş yapın.</p></div>';
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
                var searchEl = document.getElementById('serviceSearch');
                var q = searchEl ? searchEl.value : '';
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
                return '<div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex items-center justify-between shadow-xl hover:border-emerald-500/50 transition">' +
                    '<div class="flex items-center gap-4">' +
                    '<div class="' + s.bg + ' ' + s.color + ' w-12 h-12 rounded-xl flex items-center justify-center text-xl border border-emerald-500/20"><i class="' + s.iconType + ' ' + s.icon + '"></i></div>' +
                    '<div><h3 class="font-bold text-sm text-white">' + s.name + '</h3>' +
                    '<p class="text-emerald-400 font-bold text-sm">' + s.price.toFixed(2) + ' TL <span class="text-xs ml-2 font-mono text-emerald-400">' + s.stock + ' Adet Stok</span></p></div>' +
                    '</div>' +
                    '<button data-code="' + s.serviceCode + '" data-country="' + s.country + '" onclick="buyNumber(this)" class="bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-xl text-sm font-bold shadow-lg transition">Numara Al</button>' +
                    '</div>';
            }

            async function buyNumber(btn) {
                var serviceCode = btn.getAttribute('data-code');
                var country = btn.getAttribute('data-country');
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Alınıyor...';

                try {
                    var res = await fetch('/api/buyNumber', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ serviceCode: serviceCode, country: country, username: currentUser })
                    });
                    var data = await res.json();
                    btn.disabled = false;
                    btn.innerText = 'Numara Al';

                    if (data.success) {
                        fetchBalance();
                        trackOrder(data.order.activationId, data.order.phoneNumber);
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

            function trackOrder(id, initialPhone) {
                if (activeTimerInterval) clearInterval(activeTimerInterval);
                var timeLeft = 600; // 10 dakika

                document.getElementById('activeOrderArea').innerHTML =
                    '<div class="bg-slate-900 border border-emerald-500 p-6 rounded-2xl shadow-2xl relative">' +
                    '<h3 class="font-bold text-emerald-400 text-lg mb-3"><i class="fa-solid fa-circle-check mr-2"></i> Numara Başarıyla Alındı</h3>' +
                    '<p class="text-sm text-slate-300">Numara: <strong class="text-white font-mono text-xl select-all">' + initialPhone + '</strong></p>' +
                    '<p class="text-sm text-slate-300 mt-2">SMS Kod: <strong id="smsCode" class="text-emerald-400 font-mono text-xl animate-pulse">Bekleniyor...</strong></p>' +
                    '<div class="mt-4 flex items-center justify-between border-t border-slate-800 pt-4">' +
                    '<span class="text-xs text-slate-400">Kod Süresi: <strong id="timerDisplay" class="text-amber-400 font-mono text-sm">10:00</strong></span>' +
                    '<div id="actionButtons"><button onclick="cancelOrder(\\'' + id + '\\')" class="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-500/40 px-4 py-2 rounded-xl text-xs font-bold transition">Değiştir / İptal Et</button></div>' +
                    '</div></div>';

                activeTimerInterval = setInterval(async function () {
                    timeLeft--;
                    var min = Math.floor(timeLeft / 60);
                    var sec = timeLeft % 60;
                    var timerEl = document.getElementById('timerDisplay');
                    if (timerEl) {
                        timerEl.innerText = String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
                    }

                    if (timeLeft <= 0) {
                        clearInterval(activeTimerInterval);
                        cancelOrder(id, true);
                        return;
                    }

                    if (timeLeft % 5 !== 0) return; // SMS'i 5 saniyede bir sorgula

                    try {
                        var res = await fetch('/api/checkSms/' + id);
                        var data = await res.json();
                        if (data.success && data.status === 'completed') {
                            clearInterval(activeTimerInterval);
                            var codeEl = document.getElementById('smsCode');
                            if (codeEl) codeEl.innerText = data.code;
                            var actionArea = document.getElementById('actionButtons');
                            if (actionArea) actionArea.innerHTML = '<span class="text-emerald-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>';
                            alert('SMS Kodunuz Geldi: ' + data.code);
                        }
                    } catch (e) {}
                }, 1000);
            }

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
                    if (activeTimerInterval) clearInterval(activeTimerInterval);
                    document.getElementById('activeOrderArea').innerHTML = '';
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
            window.onload = init;
        </script>
    </body>
    </html>
    `);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, async () => {
    console.log(`Sunucu ${PORT} portunda çalışıyor.`);
    if (!ONAYLI_SMS_API_KEY) console.warn('UYARI: ONAYLI_SMS_API_KEY ayarlanmamış!');
    try {
        const webhookUrl = `${RENDER_EXTERNAL_URL}${webhookPath}`;
        await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    } catch (err) {}
});
