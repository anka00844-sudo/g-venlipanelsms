const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// ====== AYARLAR (Render > Environment) ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://yenipanel.onrender.com';
const ONAYLI_SMS_API_KEY = process.env.ONAYLI_SMS_API_KEY || 'osms_7f193a3fe65448a9380061c1b56e9fdc29f49c67e89eb3dd';
const ONAYLI_SMS_URL = 'https://onaylasms.com.tr/stubs/handler_api.php';
const PRICE_MULTIPLIER = parseFloat(process.env.PRICE_MULTIPLIER || '1');
const MAX_COST_FACTOR = parseFloat(process.env.MAX_COST_FACTOR || '0.85');

let db = {
    users: {
        "Aklomanti": { username: "Aklomanti", password: "Aklomanti", balance: 5000, role: "admin", createdAt: "01.01.2024 00:00:00" }
    },
    payments: {},
    visitors: [],
    logins: [],
    orders: {}
};

// Ziyaretçi takibi
app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!db.visitors.some(v => v.ip === ip)) {
        db.visitors.unshift({ ip, time: new Date().toLocaleString('tr-TR'), userAgent: req.headers['user-agent'] || 'Bilinmiyor' });
        if (db.visitors.length > 100) db.visitors.pop();
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

// DÜZELTİLMİŞ KATALOG: Türkiye ID'si 62 değil, 'tr' için dinamik eşleşme ve doğru defCountry kullanımı
const CATALOG = [
    { id: 'wa_tr', key: 'tr', name: 'WhatsApp Türkiye',   serviceCode: 'wa', defCountry: '62',  price: 300 }, // getCountries'ten TR id'si otomatik bulunacak
    { id: 'tg_tr', key: 'tr', name: 'Telegram Türkiye',   serviceCode: 'tg', defCountry: '62',  price: 200 },
    { id: 'wa_ph', key: 'ph', name: 'WhatsApp Filipinler', serviceCode: 'wa', defCountry: '4',   price: 200 },
    { id: 'tg_us', key: 'us', name: 'Telegram ABD',        serviceCode: 'tg', defCountry: '187', alt: ['12', '187'], price: 200 }
];

const COUNTRY_WANT = {
    tr: ['turkey', 'türkiye', 'turkiye', 'турция', 'tr'],
    ph: ['philippines', 'filipinler', 'филиппины', 'ph'],
    us: ['usa', 'united states', 'united states of america', 'abd', 'сша', 'us']
};

let countryCache = { time: 0, map: {}, count: 0 };
async function resolveCountries() {
    if (countryCache.time && Date.now() - countryCache.time < 3600000) return countryCache.map;
    const map = {};
    try {
        const r = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getCountries' }, timeout: 15000 });
        let d = r.data;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        if (d && typeof d === 'object') {
            const arr = Array.isArray(d) ? d : Object.keys(d).map(k => Object.assign({ _k: k }, typeof d[k] === 'object' ? d[k] : { name: d[k] }));
            countryCache.count = arr.length;
            for (const c of arr) {
                if (!c || typeof c !== 'object') continue;
                const id = c.id !== undefined ? String(c.id) : (c._k !== undefined ? String(c._k) : null);
                if (id === null) continue;
                const names = [c.eng, c.rus, c.name, c.title, c.tr, c.country, c.iso].filter(Boolean).map(x => String(x).toLowerCase().trim());
                for (const key in COUNTRY_WANT) {
                    if (!map[key] && names.some(n => COUNTRY_WANT[key].includes(n))) map[key] = id;
                }
            }
        }
    } catch (e) {}
    countryCache = { time: Date.now(), map, count: countryCache.count };
    return map;
}

async function countryOf(item) {
    const map = await resolveCountries();
    return map[item.key] || item.defCountry;
}

function isAdmin(name) {
    return db.users[name] && db.users[name].role === 'admin';
}

// ====== API ENDPOINTLARI ======

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

    const newUser = { 
        username, 
        password, 
        balance: 0, 
        role: "user", 
        createdAt: new Date().toLocaleString('tr-TR') 
    };
    db.users[username] = newUser;
    res.json({ success: true, username, role: "user" });
});

app.post('/api/deposit/notify', async (req, res) => {
    const { username, senderName, amount } = req.body;
    if (!username || !senderName || !amount) return res.json({ success: false, message: "Tüm alanları doldurun." });

    const paymentId = 'pay_' + Date.now();
    db.payments[paymentId] = { 
        id: paymentId, 
        username, 
        senderName, 
        amount: parseFloat(amount), 
        status: 'pending', 
        time: new Date().toLocaleString('tr-TR') 
    };

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `🔥 ANKA PANEL - YENİ ÖDEME BİLDİRİMİ!\n\n👤 Kullanıcı: ${username}\n✍️ Gönderen: ${senderName}\n💵 Tutar: ${amount} TL`,
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

    res.json({ success: true, message: "Ödeme bildiriminiz alındı. Admin incelemesinden sonra bakiyeniz yüklenecektir." });
});

// Gelişmiş Admin Veri Paneli Endpoint'i
app.get('/api/admin/getData', (req, res) => {
    const { adminUsername } = req.query;
    if (!isAdmin(adminUsername)) {
        return res.status(403).json({ success: false, message: "Yetkisiz erişim." });
    }
    res.json({ 
        success: true, 
        visitors: db.visitors, 
        logins: db.logins, 
        users: db.users, 
        payments: db.payments, 
        orders: db.orders 
    });
});

app.post('/api/admin/processPayment', (req, res) => {
    const { adminUsername, paymentId, action } = req.body;
    if (!isAdmin(adminUsername)) return res.json({ success: false, message: "Yetkisiz." });

    const payment = db.payments[paymentId];
    if (!payment || payment.status !== 'pending') return res.json({ success: false, message: "İşlem yapılabilir ödeme bulunamadı." });

    if (action === 'approve') {
        payment.status = 'approved';
        if (db.users[payment.username]) db.users[payment.username].balance += payment.amount;
        res.json({ success: true, message: "Ödeme onaylandı ve bakiye eklendi." });
    } else {
        payment.status = 'rejected';
        res.json({ success: true, message: "Ödeme reddedildi." });
    }
});

app.post('/api/admin/updateUserBalance', (req, res) => {
    const { adminUsername, targetUsername, newBalance } = req.body;
    if (!isAdmin(adminUsername)) return res.json({ success: false, message: "Yetkisiz." });
    if (!db.users[targetUsername]) return res.json({ success: false, message: "Kullanıcı bulunamadı." });

    db.users[targetUsername].balance = parseFloat(newBalance) || 0;
    res.json({ success: true, message: `${targetUsername} bakiyesi güncellendi.` });
});

// ====== KÖKTEN ÇÖZÜLMÜŞ NUMARA SATIN ALMA ======
app.post('/api/buyNumber', async (req, res) => {
    const { productId, username } = req.body;
    const userObj = db.users[username];
    if (!userObj) return res.json({ success: false, message: "Kullanıcı bulunamadı." });

    const item = CATALOG.find(c => c.id === productId);
    if (!item) return res.json({ success: false, message: "Geçersiz ürün." });

    if (userObj.balance < item.price) return res.json({ success: false, message: "Yetersiz bakiye! Lütfen ödeme yapın." });

    try {
        const mainCountry = await countryOf(item);
        const countriesToTry = [mainCountry].concat(item.alt || []).filter((v, i, a) => a.indexOf(v) === i);

        // 1. Sağlayıcı Anlık Bakiye Kontrolü
        let providerBalance = null;
        try {
            const bResp = await axios.get(ONAYLI_SMS_URL, { params: { api_key: ONAYLI_SMS_API_KEY, action: 'getBalance' }, timeout: 10000 });
            const bm = String(bResp.data || '').match(/ACCESS_BALANCE:([0-9.]+)/);
            if (bm) providerBalance = parseFloat(bm[1]);
        } catch (e) {}

        let lastResponse = '';
        let successfulOrder = null;

        for (const countryCode of countriesToTry) {
            // A AŞAMASI: Standart getNumber Çağrısı
            try {
                const resp = await axios.get(ONAYLI_SMS_URL, {
                    params: { api_key: ONAYLI_SMS_API_KEY, action: 'getNumber', service: item.serviceCode, country: countryCode },
                    timeout: 20000
                });
                lastResponse = String(resp.data || '').trim();
                
                if (lastResponse.startsWith('ACCESS_NUMBER')) {
                    successfulOrder = { text: lastResponse, country: countryCode };
                    break;
                }
            } catch (err) {}

            // B AŞAMASI: Eğer NO_NUMBERS veya fiyat uyuşmazlığı geldiyse maxPrice ile Güvenli Çağrı
            if (lastResponse.startsWith('NO_NUMBERS') || lastResponse.startsWith('WRONG_MAX_PRICE')) {
                let safeMaxPrice = Math.floor(item.price * MAX_COST_FACTOR);
                if (providerBalance !== null) {
                    safeMaxPrice = Math.min(safeMaxPrice, Math.floor(providerBalance));
                }

                if (safeMaxPrice >= 1) {
                    try {
                        const resp2 = await axios.get(ONAYLI_SMS_URL, {
                            params: { 
                                api_key: ONAYLI_SMS_API_KEY, 
                                action: 'getNumber', 
                                service: item.serviceCode, 
                                country: countryCode, 
                                freePrice: 'true', 
                                maxPrice: safeMaxPrice 
                            },
                            timeout: 20000
                        });
                        const resp2Text = String(resp2.data || '').trim();
                        if (resp2Text.startsWith('ACCESS_NUMBER')) {
                            successfulOrder = { text: resp2Text, country: countryCode };
                            break;
                        } else {
                            lastResponse = resp2Text;
                        }
                    } catch (err) {}
                }
            }
        }

        if (successfulOrder) {
            const parts = successfulOrder.text.split(':');
            const activationId = parts[1];
            const phoneNumber = parts.slice(2).join(':');

            userObj.balance -= item.price;

            const order = {
                activationId,
                productName: item.name,
                price: item.price,
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

        // Hata Yönetimi
        let errorMsg = "Şu anda bu servis için numara stokta yok. Lütfen 1-2 dakika sonra tekrar deneyin.";
        if (lastResponse.startsWith('NO_BALANCE')) {
            errorMsg = "Sistem bakiyesi güncellemedeyken istek atıldı. Lütfen birazdan tekrar deneyin.";
        } else if (userObj.role === 'admin') {
            errorMsg = `[ADMIN DETAYI] Hata: ${lastResponse} | Bakiye: ${providerBalance}`;
        }

        return res.json({ success: false, message: errorMsg });

    } catch (error) {
        return res.json({ success: false, message: "Sağlayıcıya erişilemedi: " + error.message });
    }
});

// ====== SİPARİŞ KONTROL & İPTAL ======
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

app.post('/api/cancelNumber', async (req, res) => {
    const { activationId, username } = req.body;
    const order = db.orders[activationId];
    const userObj = db.users[username];

    if (!order || !userObj || order.username !== username) return res.json({ success: false, message: "Sipariş bulunamadı." });
    if (order.status !== 'waiting') return res.json({ success: false, message: "Bu sipariş iptal edilemez." });

    try {
        const resp = await axios.get(ONAYLI_SMS_URL, {
            params: { api_key: ONAYLI_SMS_API_KEY, action: 'setStatus', status: 8, id: activationId },
            timeout: 15000
        });
        const text = String(resp.data || '').trim();

        if (text.startsWith('ACCESS_CANCEL')) {
            userObj.balance += order.price;
            order.status = 'cancelled';
            return res.json({ success: true, message: "Numara iptal edildi ve bakiye hesabınıza iade edildi." });
        }
        if (text.startsWith('EARLY_CANCEL_DENIED')) {
            return res.json({ success: false, message: "İlk 2 dakika numara iptal edilemez. Lütfen bekleyip tekrar deneyin." });
        }
        return res.json({ success: false, message: "İptal başarısız: " + text });
    } catch (error) {
        return res.json({ success: false, message: "Bağlantı hatası: " + error.message });
    }
});

app.get('/api/checkSms/:id', async (req, res) => {
    const activationId = req.params.id;
    const order = db.orders[activationId];
    if (!order || order.status !== 'waiting') return res.json({ success: false, message: "Sipariş aktif değil." });

    try {
        const resp = await axios.get(ONAYLI_SMS_URL, {
            params: { api_key: ONAYLI_SMS_API_KEY, action: 'getStatus', id: activationId },
            timeout: 15000
        });
        let responseText = String(resp.data || '').trim();

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

// TELEGRAM WEBHOOK
const webhookPath = `/api/telegram-webhook-${TELEGRAM_BOT_TOKEN}`;
app.post(webhookPath, async (req, res) => {
    const update = req.body;
    try {
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
    } catch (e) {}
    res.sendStatus(200);
});

// ====== MODERN ARAYÜZ (YENİLENMİŞ ANKA TEMASI VE FULL ADMIN PANELİ) ======
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="tr" class="dark">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Anka SMS - Cyber SMS Panel</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
        
        <style>
            body { font-family: 'Plus Jakarta Sans', sans-serif; background-color: #030712; color: #f3f4f6; overflow-x: hidden; }
            .font-orbitron { font-family: 'Orbitron', sans-serif; }
            
            /* Anka Alev Efektleri */
            .anka-text {
                background: linear-gradient(135deg, #ff4500 0%, #ff8c00 50%, #ffd700 100%);
                -webkit-background-clip: text;
                -webkit-text-fill-color: transparent;
                filter: drop-shadow(0 0 12px rgba(255, 69, 0, 0.4));
            }
            .anka-glow {
                box-shadow: 0 0 35px -5px rgba(255, 69, 0, 0.3);
            }
            .anka-border {
                border: 1px solid rgba(255, 140, 0, 0.25);
            }
            .glass-card {
                background: rgba(17, 24, 39, 0.75);
                backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.08);
            }
            
            /* Animasyonlar */
            @keyframes pulse-flame {
                0%, 100% { transform: scale(1); filter: drop-shadow(0 0 15px rgba(255, 69, 0, 0.6)); }
                50% { transform: scale(1.04); filter: drop-shadow(0 0 28px rgba(255, 140, 0, 0.8)); }
            }
            .phoenix-animate { animation: pulse-flame 4s ease-in-out infinite; }
            
            /* Arka Plan Alev Parçacıkları */
            #bg-canvas { position: fixed; top:0; left:0; width:100%; height:100%; z-index:-1; opacity: 0.35; }
        </style>
    </head>
    <body class="min-h-screen flex flex-col justify-between">
        <canvas id="bg-canvas"></canvas>

        <!-- ÜST NAV -->
        <nav class="glass-card sticky top-0 z-50 border-b border-gray-800/80 px-6 py-4">
            <div class="max-w-7xl mx-auto flex justify-between items-center">
                <div class="flex items-center space-x-3 cursor-pointer" onclick="showSection('store')">
                    <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-orange-600 to-amber-500 flex items-center justify-center text-white shadow-lg shadow-orange-500/30">
                        <i class="fa-solid fa-fire-flame-curved text-xl"></i>
                    </div>
                    <span class="text-2xl font-black font-orbitron tracking-wider anka-text">ANKA SMS</span>
                </div>

                <div id="nav-user-info" class="hidden flex items-center space-x-4">
                    <div class="bg-gray-900/90 border border-orange-500/30 px-4 py-1.5 rounded-full flex items-center space-x-2">
                        <i class="fa-solid fa-wallet text-amber-400"></i>
                        <span id="user-balance-display" class="font-bold text-amber-400">0.00 TL</span>
                    </div>
                    <span id="user-name-display" class="font-bold text-gray-300"></span>
                    <button id="admin-nav-btn" onclick="showSection('admin')" class="hidden bg-red-600/20 text-red-400 border border-red-500/30 px-3 py-1.5 rounded-lg text-sm font-semibold hover:bg-red-600/30">Admin</button>
                    <button onclick="logout()" class="text-gray-400 hover:text-white"><i class="fa-solid fa-right-from-bracket text-lg"></i></button>
                </div>
            </div>
        </nav>

        <main class="max-w-7xl mx-auto px-4 py-8 flex-1 w-full">
            
            <!-- ====== YENİLENMİŞ HAVALI ANKA GİRİŞ / KAYIT EKRANI ====== -->
            <section id="sec-auth" class="max-w-md mx-auto my-12">
                <div class="glass-card anka-glow rounded-3xl p-8 anka-border relative overflow-hidden">
                    <div class="text-center mb-8">
                        <div class="phoenix-animate inline-block mb-3">
                            <i class="fa-solid fa-[#ff4500] fa-fire-sharp text-6xl text-orange-500"></i>
                            <div class="text-5xl font-black font-orbitron anka-text tracking-widest mt-2">ANKA</div>
                        </div>
                        <p class="text-gray-400 text-sm mt-1">Sanal Numara & Otomasyon Paneli</p>
                    </div>

                    <!-- TAB SEÇİMİ -->
                    <div class="flex bg-gray-900/80 p-1 rounded-xl mb-6 border border-gray-800">
                        <button id="btn-tab-login" onclick="switchAuthTab('login')" class="flex-1 py-2 rounded-lg font-semibold text-sm transition-all bg-orange-600 text-white shadow-md">Giriş Yap</button>
                        <button id="btn-tab-register" onclick="switchAuthTab('register')" class="flex-1 py-2 rounded-lg font-semibold text-sm text-gray-400 hover:text-white transition-all">Kayıt Ol</button>
                    </div>

                    <!-- GİRİŞ FORMU -->
                    <form id="form-login" onsubmit="handleLogin(event)" class="space-y-4">
                        <div>
                            <label class="block text-xs font-bold text-gray-400 uppercase mb-1">Kullanıcı Adı</label>
                            <input type="text" id="login-username" required class="w-full bg-gray-900/90 border border-gray-700 rounded-xl px-4 py-3 text-gray-100 focus:outline-none focus:border-orange-500 transition-colors">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-gray-400 uppercase mb-1">Şifre</label>
                            <input type="password" id="login-password" required class="w-full bg-gray-900/90 border border-gray-700 rounded-xl px-4 py-3 text-gray-100 focus:outline-none focus:border-orange-500 transition-colors">
                        </div>
                        <button type="submit" class="w-full bg-gradient-to-r from-orange-600 to-amber-600 text-white font-bold py-3.5 rounded-xl shadow-lg shadow-orange-600/30 hover:opacity-90 transition-opacity">Sisteme Giriş Et</button>
                    </form>

                    <!-- KAYIT FORMU -->
                    <form id="form-register" onsubmit="handleRegister(event)" class="space-y-4 hidden">
                        <div>
                            <label class="block text-xs font-bold text-gray-400 uppercase mb-1">Kullanıcı Adı Belirleyin</label>
                            <input type="text" id="reg-username" required class="w-full bg-gray-900/90 border border-gray-700 rounded-xl px-4 py-3 text-gray-100 focus:outline-none focus:border-orange-500 transition-colors">
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-gray-400 uppercase mb-1">Şifre Belirleyin</label>
                            <input type="password" id="reg-password" required class="w-full bg-gray-900/90 border border-gray-700 rounded-xl px-4 py-3 text-gray-100 focus:outline-none focus:border-orange-500 transition-colors">
                        </div>
                        <button type="submit" class="w-full bg-gradient-to-r from-amber-600 to-orange-600 text-white font-bold py-3.5 rounded-xl shadow-lg shadow-amber-600/30 hover:opacity-90 transition-opacity">Hesap Oluştur</button>
                    </form>

                    <div id="auth-msg" class="mt-4 text-center text-sm font-semibold text-red-400"></div>
                </div>
            </section>

            <!-- ====== MAĞAZA & AKTİF NUMARALAR ====== -->
            <section id="sec-store" class="hidden space-y-8">
                <!-- BAKİYE YÜKLEME BUTONU VE DOKÜMAN -->
                <div class="flex justify-between items-center bg-gray-900/60 p-4 rounded-2xl border border-gray-800">
                    <div>
                        <h2 class="text-xl font-bold font-orbitron text-gray-100">Numara Satın Al</h2>
                        <p class="text-xs text-gray-400">7/24 Kesintisiz Anında SMS Onay Servisi</p>
                    </div>
                    <button onclick="openDepositModal()" class="bg-amber-500/10 text-amber-400 border border-amber-500/30 px-4 py-2 rounded-xl text-sm font-bold hover:bg-amber-500/20 transition-all flex items-center space-x-2">
                        <i class="fa-solid fa-plus-circle"></i> <span>Bakiye Yükle</span>
                    </button>
                </div>

                <!-- AKTİF NUMARALAR ALANI -->
                <div id="active-orders-container" class="space-y-3"></div>

                <!-- ÜRÜN KATALOĞU -->
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6" id="products-grid"></div>
            </section>

            <!-- ====== GELİŞMİŞ EKSİKSİZ ADMİN PANELİ ====== -->
            <section id="sec-admin" class="hidden space-y-8">
                <div class="flex justify-between items-center border-b border-gray-800 pb-4">
                    <h1 class="text-2xl font-black font-orbitron text-red-500 flex items-center space-x-2">
                        <i class="fa-solid fa-user-shield"></i> <span>ANKA YÖNETİM PANELİ</span>
                    </h1>
                    <button onclick="loadAdminData()" class="bg-gray-800 text-gray-200 px-3 py-1.5 rounded-lg text-sm hover:bg-gray-700"><i class="fa-solid fa-rotate"></i> Verileri Yenile</button>
                </div>

                <!-- İSTATİSTİK ÖZETİ -->
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div class="glass-card p-4 rounded-2xl border-l-4 border-blue-500">
                        <span class="text-xs text-gray-400 block font-bold">TOPLAM KULLANICI</span>
                        <span id="stat-users-count" class="text-2xl font-bold text-white">0</span>
                    </div>
                    <div class="glass-card p-4 rounded-2xl border-l-4 border-amber-500">
                        <span class="text-xs text-gray-400 block font-bold">BEKLEYEN ÖDEMELER</span>
                        <span id="stat-pending-payments" class="text-2xl font-bold text-amber-400">0</span>
                    </div>
                    <div class="glass-card p-4 rounded-2xl border-l-4 border-emerald-500">
                        <span class="text-xs text-gray-400 block font-bold">TAMAMLANAN SİPARİŞ</span>
                        <span id="stat-orders-count" class="text-2xl font-bold text-emerald-400">0</span>
                    </div>
                    <div class="glass-card p-4 rounded-2xl border-l-4 border-purple-500">
                        <span class="text-xs text-gray-400 block font-bold">TOPLAM ZİYARET</span>
                        <span id="stat-visitors-count" class="text-2xl font-bold text-purple-400">0</span>
                    </div>
                </div>

                <!-- ADMİN SEKMELERİ -->
                <div class="space-y-6">
                    <!-- 1. ÖDEME BİLDİRİMLERİ -->
                    <div class="glass-card p-6 rounded-2xl border border-gray-800">
                        <h2 class="text-lg font-bold text-amber-400 mb-4 flex items-center space-x-2"><i class="fa-solid fa-receipt"></i> <span>Ödeme Bildirimleri</span></h2>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left text-sm text-gray-300">
                                <thead class="bg-gray-900/80 text-gray-400 uppercase text-xs">
                                    <tr>
                                        <th class="p-3">ID</th>
                                        <th class="p-3">Kullanıcı</th>
                                        <th class="p-3">Gönderen Adı</th>
                                        <th class="p-3">Tutar</th>
                                        <th class="p-3">Tarih</th>
                                        <th class="p-3">Durum</th>
                                        <th class="p-3">İşlem</th>
                                    </tr>
                                </thead>
                                <tbody id="table-admin-payments"></tbody>
                            </table>
                        </div>
                    </div>

                    <!-- 2. KAYITLI KULLANICILAR & BAKİYE DÜZENLEME -->
                    <div class="glass-card p-6 rounded-2xl border border-gray-800">
                        <h2 class="text-lg font-bold text-blue-400 mb-4 flex items-center space-x-2"><i class="fa-solid fa-users"></i> <span>Kayıtlı Kullanıcılar</span></h2>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left text-sm text-gray-300">
                                <thead class="bg-gray-900/80 text-gray-400 uppercase text-xs">
                                    <tr>
                                        <th class="p-3">Kullanıcı Adı</th>
                                        <th class="p-3">Şifre</th>
                                        <th class="p-3">Bakiye</th>
                                        <th class="p-3">Rol</th>
                                        <th class="p-3">Kayıt Tarihi</th>
                                        <th class="p-3">Bakiye Yönet</th>
                                    </tr>
                                </thead>
                                <tbody id="table-admin-users"></tbody>
                            </table>
                        </div>
                    </div>

                    <!-- 3. SİPARİŞ GEÇMİŞİ -->
                    <div class="glass-card p-6 rounded-2xl border border-gray-800">
                        <h2 class="text-lg font-bold text-emerald-400 mb-4 flex items-center space-x-2"><i class="fa-solid fa-shopping-cart"></i> <span>Tüm Numara Siparişleri</span></h2>
                        <div class="overflow-x-auto">
                            <table class="w-full text-left text-sm text-gray-300">
                                <thead class="bg-gray-900/80 text-gray-400 uppercase text-xs">
                                    <tr>
                                        <th class="p-3">Kullanıcı</th>
                                        <th class="p-3">Ürün</th>
                                        <th class="p-3">Numara</th>
                                        <th class="p-3">Gelen Kod</th>
                                        <th class="p-3">Fiyat</th>
                                        <th class="p-3">Durum</th>
                                        <th class="p-3">Tarih</th>
                                    </tr>
                                </thead>
                                <tbody id="table-admin-orders"></tbody>
                            </table>
                        </div>
                    </div>

                    <!-- 4. ZİYARETÇİ VE GİRİŞ LOGLARI -->
                    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                        <div class="glass-card p-6 rounded-2xl border border-gray-800">
                            <h2 class="text-lg font-bold text-purple-400 mb-4"><i class="fa-solid fa-right-to-bracket"></i> Son Giriş Yapanlar</h2>
                            <div class="overflow-y-auto max-h-60">
                                <table class="w-full text-left text-xs text-gray-300">
                                    <thead class="bg-gray-900/80 text-gray-400"><tr><th class="p-2">Kullanıcı</th><th class="p-2">IP</th><th class="p-2">Tarih</th></tr></thead>
                                    <tbody id="table-admin-logins"></tbody>
                                </table>
                            </div>
                        </div>

                        <div class="glass-card p-6 rounded-2xl border border-gray-800">
                            <h2 class="text-lg font-bold text-gray-400 mb-4"><i class="fa-solid fa-eye"></i> Son Ziyaretçi IP'leri</h2>
                            <div class="overflow-y-auto max-h-60">
                                <table class="w-full text-left text-xs text-gray-300">
                                    <thead class="bg-gray-900/80 text-gray-400"><tr><th class="p-2">IP</th><th class="p-2">Tarih</th></tr></thead>
                                    <tbody id="table-admin-visitors"></tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        </main>

        <!-- ÖDEME BİLDİRİM MODAL -->
        <div id="modal-deposit" class="hidden fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div class="glass-card max-w-md w-full rounded-2xl p-6 border border-gray-800 relative">
                <button onclick="closeDepositModal()" class="absolute top-4 right-4 text-gray-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
                <h3 class="text-xl font-bold font-orbitron text-amber-400 mb-4">Bakiye Yükle / Ödeme Bildir</h3>
                <form onsubmit="handleDepositNotify(event)" class="space-y-4">
                    <div>
                        <label class="block text-xs text-gray-400 uppercase mb-1">Gönderen Ad Soyad</label>
                        <input type="text" id="dep-sender" required class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-gray-100">
                    </div>
                    <div>
                        <label class="block text-xs text-gray-400 uppercase mb-1">Yüklenen Tutar (TL)</label>
                        <input type="number" id="dep-amount" min="10" required class="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-gray-100">
                    </div>
                    <button type="submit" class="w-full bg-amber-500 text-gray-950 font-bold py-3 rounded-xl hover:bg-amber-400">Ödeme Bildirimi Gönder</button>
                </form>
            </div>
        </div>

        <script>
            let currentUser = null;

            // CANVAS BACKGROUND ANIMASYONU
            const canvas = document.getElementById('bg-canvas');
            const ctx = canvas.getContext('2d');
            function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
            window.addEventListener('resize', resizeCanvas);
            resizeCanvas();

            const particles = Array.from({length: 45}, () => ({
                x: Math.random() * canvas.width,
                y: Math.random() * canvas.height,
                size: Math.random() * 3 + 1,
                speedY: Math.random() * 1.5 + 0.5,
                opacity: Math.random() * 0.5 + 0.2
            }));

            function drawParticles() {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                particles.forEach(p => {
                    p.y -= p.speedY;
                    if (p.y < 0) p.y = canvas.height;
                    ctx.fillStyle = \`rgba(255, 69, 0, \${p.opacity})\`;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
                    ctx.fill();
                });
                requestAnimationFrame(drawParticles);
            }
            drawParticles();

            // SİSTEM FONKSİYONLARI
            function switchAuthTab(tab) {
                if (tab === 'login') {
                    document.getElementById('form-login').classList.remove('hidden');
                    document.getElementById('form-register').classList.add('hidden');
                    document.getElementById('btn-tab-login').className = "flex-1 py-2 rounded-lg font-semibold text-sm transition-all bg-orange-600 text-white shadow-md";
                    document.getElementById('btn-tab-register').className = "flex-1 py-2 rounded-lg font-semibold text-sm text-gray-400 hover:text-white transition-all";
                } else {
                    document.getElementById('form-login').classList.add('hidden');
                    document.getElementById('form-register').classList.remove('hidden');
                    document.getElementById('btn-tab-register').className = "flex-1 py-2 rounded-lg font-semibold text-sm transition-all bg-orange-600 text-white shadow-md";
                    document.getElementById('btn-tab-login').className = "flex-1 py-2 rounded-lg font-semibold text-sm text-gray-400 hover:text-white transition-all";
                }
            }

            function showSection(sec) {
                document.getElementById('sec-auth').classList.add('hidden');
                document.getElementById('sec-store').classList.add('hidden');
                document.getElementById('sec-admin').classList.add('hidden');

                if (sec === 'store') {
                    document.getElementById('sec-store').classList.remove('hidden');
                    loadProducts();
                    loadMyOrders();
                } else if (sec === 'admin') {
                    document.getElementById('sec-admin').classList.remove('hidden');
                    loadAdminData();
                } else {
                    document.getElementById('sec-auth').classList.remove('hidden');
                }
            }

            async function handleLogin(e) {
                e.preventDefault();
                const u = document.getElementById('login-username').value;
                const p = document.getElementById('login-password').value;
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ username: u, password: p })
                }).then(r => r.json());

                if (res.success) {
                    currentUser = res.username;
                    setupUser(res.username, res.role);
                } else {
                    document.getElementById('auth-msg').innerText = res.message;
                }
            }

            async function handleRegister(e) {
                e.preventDefault();
                const u = document.getElementById('reg-username').value;
                const p = document.getElementById('reg-password').value;
                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ username: u, password: p })
                }).then(r => r.json());

                if (res.success) {
                    currentUser = res.username;
                    setupUser(res.username, 'user');
                } else {
                    document.getElementById('auth-msg').innerText = res.message;
                }
            }

            function setupUser(username, role) {
                document.getElementById('nav-user-info').classList.remove('hidden');
                document.getElementById('user-name-display').innerText = username;
                if (role === 'admin') document.getElementById('admin-nav-btn').classList.remove('hidden');
                updateBalance();
                showSection('store');
            }

            async function updateBalance() {
                if (!currentUser) return;
                const res = await fetch(\`/api/getCustomerBalance?username=\${currentUser}\`).then(r => r.json());
                if (res.success) {
                    document.getElementById('user-balance-display').innerText = res.balance.toFixed(2) + ' TL';
                }
            }

            function logout() {
                currentUser = null;
                document.getElementById('nav-user-info').classList.add('hidden');
                showSection('auth');
            }

            async function loadProducts() {
                const res = await fetch('/api/getServices').then(r => r.json());
                const grid = document.getElementById('products-grid');
                grid.innerHTML = '';

                res.services.forEach(p => {
                    grid.innerHTML += \`
                        <div class="glass-card rounded-2xl p-6 border border-gray-800 hover:border-orange-500/50 transition-all flex flex-col justify-between">
                            <div>
                                <div class="flex justify-between items-center mb-4">
                                    <div class="w-12 h-12 rounded-xl \${p.bg} flex items-center justify-center \${p.color} text-2xl">
                                        <i class="\${p.iconType} \${p.icon}"></i>
                                    </div>
                                    <span class="text-xl font-bold font-orbitron text-amber-400">\${p.price} TL</span>
                                </div>
                                <h3 class="text-lg font-bold text-gray-100 mb-1">\${p.name}</h3>
                                <p class="text-xs text-gray-400">Anında Kod Onaylı Sanal Numara</p>
                            </div>
                            <button onclick="buyNumber('\${p.id}')" class="mt-6 w-full bg-gray-900 border border-orange-500/40 text-orange-400 font-bold py-2.5 rounded-xl hover:bg-orange-600 hover:text-white transition-all">
                                Satın Al
                            </button>
                        </div>
                    \`;
                });
            }

            async function buyNumber(productId) {
                const res = await fetch('/api/buyNumber', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ productId, username: currentUser })
                }).then(r => r.json());

                if (res.success) {
                    updateBalance();
                    loadMyOrders();
                } else {
                    alert(res.message);
                }
            }

            async function loadMyOrders() {
                const res = await fetch(\`/api/myOrders?username=\${currentUser}\`).then(r => r.json());
                const container = document.getElementById('active-orders-container');
                container.innerHTML = '';

                res.orders.forEach(o => {
                    container.innerHTML += \`
                        <div class="glass-card p-4 rounded-xl border border-orange-500/30 flex flex-col md:flex-row justify-between items-center gap-4">
                            <div>
                                <span class="text-xs text-orange-400 font-bold block">\${o.productName}</span>
                                <span class="text-lg font-bold font-orbitron text-white">\${o.phoneNumber}</span>
                            </div>
                            <div class="text-center">
                                <span class="text-xs text-gray-400 block">SMS KODU</span>
                                <span class="text-xl font-bold text-amber-400 font-orbitron">\${o.code}</span>
                            </div>
                            <div class="flex items-center space-x-2">
                                \${o.status === 'waiting' ? \`
                                    <button onclick="checkSms('\${o.activationId}')" class="bg-blue-600/20 text-blue-400 border border-blue-500/30 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-blue-600/40">Sorgula</button>
                                    <button onclick="cancelOrder('\${o.activationId}')" class="bg-red-600/20 text-red-400 border border-red-500/30 px-3 py-1.5 rounded-lg text-xs font-bold hover:bg-red-600/40">İptal Et</button>
                                \` : '<span class="text-xs text-emerald-400 font-bold">Tamamlandı</span>'}
                            </div>
                        </div>
                    \`;
                });
            }

            async function checkSms(id) {
                const res = await fetch(\`/api/checkSms/\${id}\`).then(r => r.json());
                if (res.code && res.code !== 'Bekleniyor...') {
                    loadMyOrders();
                } else {
                    alert('Kod henüz gelmedi, lütfen bekleyin.');
                }
            }

            async function cancelOrder(activationId) {
                const res = await fetch('/api/cancelNumber', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ activationId, username: currentUser })
                }).then(r => r.json());

                alert(res.message);
                if (res.success) {
                    updateBalance();
                    loadMyOrders();
                }
            }

            // MODAL & ÖDEME
            function openDepositModal() { document.getElementById('modal-deposit').classList.remove('hidden'); }
            function closeDepositModal() { document.getElementById('modal-deposit').classList.add('hidden'); }

            async function handleDepositNotify(e) {
                e.preventDefault();
                const s = document.getElementById('dep-sender').value;
                const a = document.getElementById('dep-amount').value;

                const res = await fetch('/api/deposit/notify', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ username: currentUser, senderName: s, amount: a })
                }).then(r => r.json());

                alert(res.message);
                closeDepositModal();
            }

            // ADMİN DATA YÜKLEYİCİ
            async function loadAdminData() {
                const res = await fetch(\`/api/admin/getData?adminUsername=\${currentUser}\`).then(r => r.json());
                if (!res.success) return alert(res.message);

                // İstatistikler
                const usersArr = Object.values(res.users);
                const paymentsArr = Object.values(res.payments);
                const ordersArr = Object.values(res.orders);

                document.getElementById('stat-users-count').innerText = usersArr.length;
                document.getElementById('stat-pending-payments').innerText = paymentsArr.filter(p => p.status === 'pending').length;
                document.getElementById('stat-orders-count').innerText = ordersArr.filter(o => o.status === 'completed').length;
                document.getElementById('stat-visitors-count').innerText = res.visitors.length;

                // Ödemeler Tablosu
                const tbodyPay = document.getElementById('table-admin-payments');
                tbodyPay.innerHTML = '';
                paymentsArr.reverse().forEach(p => {
                    tbodyPay.innerHTML += \`
                        <tr class="border-b border-gray-800">
                            <td class="p-3 text-xs">\${p.id}</td>
                            <td class="p-3 font-bold text-white">\${p.username}</td>
                            <td class="p-3">\${p.senderName}</td>
                            <td class="p-3 text-amber-400 font-bold">\${p.amount} TL</td>
                            <td class="p-3 text-xs">\${p.time}</td>
                            <td class="p-3"><span class="px-2 py-0.5 rounded text-xs font-bold \${p.status === 'approved' ? 'bg-emerald-500/10 text-emerald-400' : (p.status === 'rejected' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400')}">\${p.status}</span></td>
                            <td class="p-3">
                                \${p.status === 'pending' ? \`
                                    <button onclick="processPayment('\${p.id}', 'approve')" class="bg-emerald-600 text-white px-2 py-1 rounded text-xs font-bold mr-1">Onayla</button>
                                    <button onclick="processPayment('\${p.id}', 'reject')" class="bg-red-600 text-white px-2 py-1 rounded text-xs font-bold">Reddet</button>
                                \` : '-'}
                            </td>
                        </tr>
                    \`;
                });

                // Kullanıcılar Tablosu
                const tbodyUsers = document.getElementById('table-admin-users');
                tbodyUsers.innerHTML = '';
                usersArr.forEach(u => {
                    tbodyUsers.innerHTML += \`
                        <tr class="border-b border-gray-800">
                            <td class="p-3 font-bold text-white">\${u.username}</td>
                            <td class="p-3 text-xs font-mono">\${u.password}</td>
                            <td class="p-3 text-amber-400 font-bold">\${u.balance.toFixed(2)} TL</td>
                            <td class="p-3"><span class="px-2 py-0.5 rounded text-xs font-bold \${u.role === 'admin' ? 'bg-red-500/20 text-red-400' : 'bg-blue-500/20 text-blue-400'}">\${u.role}</span></td>
                            <td class="p-3 text-xs">\${u.createdAt || '-'}</td>
                            <td class="p-3">
                                <button onclick="editUserBalance('\${u.username}', \${u.balance})" class="bg-blue-600/20 text-blue-400 border border-blue-500/30 px-2 py-1 rounded text-xs font-bold">Bakiye Değiştir</button>
                            </td>
                        </tr>
                    \`;
                });

                // Siparişler Tablosu
                const tbodyOrders = document.getElementById('table-admin-orders');
                tbodyOrders.innerHTML = '';
                ordersArr.reverse().forEach(o => {
                    tbodyOrders.innerHTML += \`
                        <tr class="border-b border-gray-800">
                            <td class="p-3 font-bold text-white">\${o.username}</td>
                            <td class="p-3 text-xs">\${o.productName}</td>
                            <td class="p-3 font-mono text-amber-400">\${o.phoneNumber}</td>
                            <td class="p-3 font-mono text-emerald-400 font-bold">\${o.code}</td>
                            <td class="p-3">\${o.price} TL</td>
                            <td class="p-3 text-xs">\${o.status}</td>
                            <td class="p-3 text-xs">\${o.time}</td>
                        </tr>
                    \`;
                });

                // Loglar
                const tbodyLogins = document.getElementById('table-admin-logins');
                tbodyLogins.innerHTML = '';
                res.logins.slice(0, 15).forEach(l => {
                    tbodyLogins.innerHTML += \`<tr class="border-b border-gray-800"><td class="p-2">\${l.username}</td><td class="p-2 font-mono">\${l.ip}</td><td class="p-2 text-gray-500">\${l.time}</td></tr>\`;
                });

                const tbodyVisitors = document.getElementById('table-admin-visitors');
                tbodyVisitors.innerHTML = '';
                res.visitors.slice(0, 15).forEach(v => {
                    tbodyVisitors.innerHTML += \`<tr class="border-b border-gray-800"><td class="p-2 font-mono">\${v.ip}</td><td class="p-2 text-gray-500">\${v.time}</td></tr>\`;
                });
            }

            async function processPayment(paymentId, action) {
                const res = await fetch('/api/admin/processPayment', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ adminUsername: currentUser, paymentId, action })
                }).then(r => r.json());

                alert(res.message);
                loadAdminData();
            }

            async function editUserBalance(targetUsername, currentBal) {
                const newBal = prompt(\`\${targetUsername} için yeni bakiye tutarını girin:\`, currentBal);
                if (newBal !== null) {
                    const res = await fetch('/api/admin/updateUserBalance', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ adminUsername: currentUser, targetUsername, newBalance: newBal })
                    }).then(r => r.json());

                    alert(res.message);
                    loadAdminData();
                }
            }
        </script>
    </body>
    </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server ${PORT} portunda Anka temasıyla yayında.`);
});
