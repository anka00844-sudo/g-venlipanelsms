const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

const TELEGRAM_BOT_TOKEN = '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = '8811977430';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://yenipanel.onrender.com';

const ONAYLI_SMS_API_KEY = 'osms_7f193a3fe65448a9380061c1b56e9fdc29f49c67e89eb3dd';
const ONAYLI_SMS_URL = 'https://onaylasms.com.tr/stubs/handler_api.php';

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

// TÜM ÜLKE VE SERVİSLERİ EKSİZSİZ LİSTELEYEN ENDPOINT
app.get('/api/getServices', async (req, res) => {
    try {
        const listUrl = `${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=getPrices`;
        const apiResp = await axios.get(listUrl);
        const apiData = apiResp.data;

        let allServices = [];

        // Popüler servis kodları ve görsel karşılıkları
        const serviceMeta = {
            'wa': { name: 'WhatsApp', icon: 'fa-whatsapp', color: 'text-emerald-400', bg: 'bg-emerald-500/10' },
            'tg': { name: 'Telegram', icon: 'fa-telegram', color: 'text-blue-400', bg: 'bg-blue-500/10' },
            'goo': { name: 'Google / Gmail', icon: 'fa-google', color: 'text-amber-400', bg: 'bg-amber-500/10' },
            'ig': { name: 'Instagram', icon: 'fa-instagram', color: 'text-pink-400', bg: 'bg-pink-500/10' },
            'tw': { name: 'Twitter / X', icon: 'fa-twitter', color: 'text-sky-400', bg: 'bg-sky-500/10' },
            'fb': { name: 'Facebook', icon: 'fa-facebook', color: 'text-blue-500', bg: 'bg-blue-600/10' },
            'nf': { name: 'Netflix', icon: 'fa-film', color: 'text-red-500', bg: 'bg-red-500/10' },
            'ds': { name: 'Discord', icon: 'fa-discord', color: 'text-indigo-400', bg: 'bg-indigo-500/10' }
        };

        // Ülke kodu isim karşılıkları
        const countryNames = {
            '90': 'Türkiye',
            '1': 'Amerika / Kanada',
            '44': 'İngiltere',
            '7': 'Rusya',
            '63': 'Filipinler',
            '62': 'Endonezya',
            '84': 'Vietnam',
            '91': 'Hindistan',
            '55': 'Brezilya',
            '33': 'Fransa',
            '49': 'Almanya'
        };

        if (apiData && typeof apiData === 'object') {
            for (let countryId in apiData) {
                let countryServices = apiData[countryId];
                for (let serviceCode in countryServices) {
                    let sInfo = countryServices[serviceCode];
                    // Stok ve fiyat bilgisi
                    let count = sInfo.count !== undefined ? sInfo.count : (sInfo.stock !== undefined ? sInfo.stock : 0);
                    let price = sInfo.cost !== undefined ? sInfo.cost : (sInfo.price !== undefined ? sInfo.price : 50);

                    let meta = serviceMeta[serviceCode.toLowerCase()] || {
                        name: serviceCode.toUpperCase(),
                        icon: 'fa-globe',
                        color: 'text-emerald-400',
                        bg: 'bg-emerald-500/10'
                    };

                    let cName = countryNames[countryId] || `Ülke Kodu: ${countryId}`;

                    allServices.push({
                        id: `${serviceCode}_${countryId}`,
                        name: `${meta.name} (${cName})`,
                        price: parseFloat(price),
                        serviceCode: serviceCode,
                        country: countryId.toString(),
                        stock: parseInt(count),
                        icon: meta.icon,
                        color: meta.color,
                        bg: meta.bg
                    });
                }
            }
        }

        // Eğer API'den veri çekilemezse veya boş dönerse genişletilmiş yedek liste sunalım
        if (allServices.length === 0) {
            allServices = [
                { id: "wa_90", name: "WhatsApp (Türkiye)", price: 300.00, serviceCode: "wa", country: "90", stock: 15, icon: "fa-whatsapp", color: "text-emerald-400", bg: "bg-emerald-500/10" },
                { id: "wa_63", name: "WhatsApp (Filipinler)", price: 150.00, serviceCode: "wa", country: "63", stock: 20, icon: "fa-whatsapp", color: "text-emerald-500/10", bg: "bg-emerald-500/10" },
                { id: "tg_1", name: "Telegram (Amerika)", price: 180.00, serviceCode: "tg", country: "1", stock: 10, icon: "fa-telegram", color: "text-blue-400", bg: "bg-blue-500/10" },
                { id: "tg_90", name: "Telegram (Türkiye)", price: 200.00, serviceCode: "tg", country: "90", stock: 8, icon: "fa-telegram", color: "text-blue-400", bg: "bg-blue-500/10" },
                { id: "goo_90", name: "Google / Gmail (Türkiye)", price: 50.00, serviceCode: "goo", country: "90", stock: 25, icon: "fa-google", color: "text-amber-400", bg: "bg-amber-500/10" },
                { id: "ig_90", name: "Instagram (Türkiye)", price: 90.00, serviceCode: "ig", country: "90", stock: 12, icon: "fa-instagram", color: "text-pink-400", bg: "bg-pink-500/10" }
            ];
        }

        res.json({ success: true, services: allServices });
    } catch (e) {
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
                        { text: "✅ Onayla", callback_data: `approve_${paymentId}` },
                        { text: "❌ Reddet", callback_data: `reject_${paymentId}` }
                    ]
                ]
            }
        });
    } catch (e) {}

    res.json({ success: true, message: "Ödeme bildiriminiz alındı. İnceleniyor." });
});

app.get('/api/admin/getData', (req, res) => {
    const { adminUsername } = req.query;
    if (!db.users[adminUsername] || db.users[adminUsername].role !== 'admin') {
        return res.status(403).json({ success: false, message: "Yetkisiz erişim." });
    }
    res.json({ success: true, visitors: db.visitors, logins: db.logins, users: db.users, payments: db.payments, orders: db.orders });
});

app.post('/api/admin/processPayment', (req, res) => {
    const { adminUsername, paymentId, action } = req.body;
    if (!db.users[adminUsername] || db.users[adminUsername].role !== 'admin') {
        return res.json({ success: false, message: "Yetkisiz." });
    }

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

app.get('/api/admin/testApi', async (req, res) => {
    try {
        const listUrl = `${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=getPrices`;
        const apiResp = await axios.get(listUrl);
        res.json({ success: true, rawApiData: apiResp.data });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// NUMARA SATIN ALMA
app.post('/api/buyNumber', async (req, res) => {
    const { serviceCode, country, price, productName, username } = req.body;
    const userObj = db.users[username];

    if (!userObj) return res.json({ success: false, message: "Kullanıcı bulunamadı." });
    if (userObj.balance < price) return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin." });

    try {
        const targetUrl = `${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=getNumber&service=${serviceCode}&country=${country}`;
        console.log(`[OnaylıSMS İstek]: ${targetUrl}`);

        const apiResponse = await axios.get(targetUrl);
        let responseText = apiResponse.data;
        if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
        responseText = responseText ? responseText.trim() : '';

        console.log(`[OnaylıSMS Yanıt]: "${responseText}"`);

        if (responseText.startsWith('ACCESS_NUMBER')) {
            const parts = responseText.split(':');
            const activationId = parts[1];
            const phoneNumber = parts.slice(2).join(':');

            userObj.balance -= price;

            const successOrder = {
                activationId,
                productName: productName || "Sanal Numara",
                price: price,
                phoneNumber,
                code: "Bekleniyor...",
                status: 'waiting',
                username,
                time: new Date().toLocaleString('tr-TR')
            };

            db.orders[activationId] = successOrder;
            return res.json({ success: true, order: successOrder });
        } else {
            return res.json({ 
                success: false, 
                message: `Sağlayıcı Yanıtı: ${responseText} (Stok tükenmiş veya servis yoğun)` 
            });
        }

    } catch (error) {
        console.error("API Bağlantı Hatası:", error.message);
        return res.json({ success: false, message: "Sağlayıcı bağlantı hatası: " + error.message });
    }
});

// NUMARA İPTAL ETME / DEĞİŞTİRME
app.post('/api/cancelNumber', async (req, res) => {
    const { activationId, username } = req.body;
    const order = db.orders[activationId];
    const userObj = db.users[username];

    if (!order || !userObj) return res.json({ success: false, message: "Sipariş bulunamadı." });
    if (order.status !== 'waiting') return res.json({ success: false, message: "Bu sipariş iptal edilemez." });

    try {
        const targetUrl = `${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=setStatus&status=8&id=${activationId}`;
        await axios.get(targetUrl);

        userObj.balance += order.price;
        order.status = 'cancelled';

        return res.json({ success: true, message: "Numara iptal edildi ve bakiye hesabınıza iade edildi." });
    } catch (error) {
        userObj.balance += order.price;
        order.status = 'cancelled';
        return res.json({ success: true, message: "Numara iptal edildi, bakiye iade edildi." });
    }
});

// SMS KOD SORGULAMA
app.get('/api/checkSms/:id', async (req, res) => {
    const activationId = req.params.id;
    const order = db.orders[activationId];
    if (!order || order.status !== 'waiting') return res.json({ success: false, message: "Sipariş aktif değil." });

    try {
        const targetUrl = `${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=getStatus&id=${activationId}`;
        const apiResponse = await axios.get(targetUrl);
        let responseText = apiResponse.data;
        if (typeof responseText === 'object') responseText = JSON.stringify(responseText);
        responseText = responseText ? responseText.trim() : '';

        if (responseText.startsWith('STATUS_OK')) {
            const parts = responseText.split(':');
            const code = parts[1];
            order.code = code;
            order.status = 'completed';
            return res.json({ success: true, status: 'completed', code, phoneNumber: order.phoneNumber });
        } else {
            return res.json({ success: true, status: 'waiting', code: "Bekleniyor...", phoneNumber: order.phoneNumber });
        }
    } catch (error) {
        return res.json({ success: true, status: 'waiting', code: "Bekleniyor...", phoneNumber: order.phoneNumber });
    }
});

const webhookPath = `/api/telegram-webhook-${TELEGRAM_BOT_TOKEN}`;
app.post(webhookPath, async (req, res) => {
    const update = req.body;
    if (update.callback_query) {
        const callbackData = update.callback_query.data;
        const chatId = update.callback_query.message.chat.id;
        if (callbackData.startsWith('approve_') || callbackData.startsWith('reject_')) {
            const [action, paymentId] = callbackData.split('_');
            const payment = db.payments[paymentId];
            if (payment && payment.status === 'pending') {
                if (action === 'approve') {
                    payment.status = 'approved';
                    if (db.users[payment.username]) db.users[payment.username].balance += payment.amount;
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `✅ Ödeme Onaylandı!\nKullanıcı: ${payment.username}\nTutar: ${payment.amount} TL` });
                } else {
                    payment.status = 'rejected';
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `❌ Ödeme Reddedildi!\nKullanıcı: ${payment.username}` });
                }
            }
        }
    }
    res.sendStatus(200);
});

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
                        <p class="text-[10px] text-emerald-500/80 font-mono">TÜM ÜLKELER VE CANLI STOK</p>
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
                <button onclick="document.getElementById('depositModal').classList.add('hidden')" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
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
            let currentUser = localStorage.getItem('currentUser') || null;
            let currentRole = localStorage.getItem('currentRole') || 'user';
            let isRegisterMode = false;
            let activeTimerInterval = null;
            let stockRefreshInterval = null;

            function init() { 
                updateUserArea(); 
                if (currentUser) {
                    loadServices(true);
                    if (stockRefreshInterval) clearInterval(stockRefreshInterval);
                    // HER SANİYE (1000ms) STOKLARI ARKADA OTOMATİK GÜNCELLE
                    stockRefreshInterval = setInterval(() => loadServices(false), 1000);
                }
            }

            function updateUserArea() {
                const area = document.getElementById('userArea');
                if (currentUser) {
                    area.innerHTML = \`
                        <div class="flex items-center gap-3">
                            <span class="text-sm font-medium">@<strong class="text-white">\${currentUser}</strong></span>
                            <span id="userBalance" class="bg-emerald-500/10 text-emerald-400 px-3.5 py-1.5 rounded-full text-xs font-bold border border-emerald-500/30">0.00 TL</span>
                            \${currentUser === 'Aklomanti' ? '<button onclick="openAdminPanel()" class="bg-amber-600 hover:bg-amber-500 px-3.5 py-1.5 rounded-xl text-xs font-bold">Admin Panel</button>' : ''}
                            <button onclick="logout()" class="text-red-400 text-sm p-2"><i class="fa-solid fa-right-from-bracket"></i></button>
                        </div>
                    \`;
                    fetchBalance();
                } else {
                    area.innerHTML = \`
                        <button onclick="openAuthModal('login')" class="bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-xl text-sm font-bold">Giriş Yap</button>
                        <button onclick="openAuthModal('register')" class="bg-slate-800 hover:bg-slate-700 px-5 py-2.5 rounded-xl text-sm font-bold">Kayıt Ol</button>
                    \`;
                    document.getElementById('mainContent').innerHTML = \`<div class="text-center py-20 bg-slate-900/70 rounded-3xl border border-emerald-500/20 p-8"><h2 class="text-3xl font-black mb-4 text-emerald-400">VIP SMS Onay Paneli</h2><p class="text-slate-400 mb-6">Devam etmek için giriş yapın.</p></div>\`;
                }
            }

            async function fetchBalance() {
                if (!currentUser) return;
                const res = await fetch(\`/api/getCustomerBalance?username=\${currentUser}\`);
                const data = await res.json();
                if (data.success) document.getElementById('userBalance').innerText = data.balance.toFixed(2) + ' TL';
            }

            async function loadServices(isInitial = false) {
                if (!currentUser) return;
                try {
                    const res = await fetch('/api/getServices');
                    const data = await res.json();
                    if (!data.success) return;

                    const main = document.getElementById('mainContent');
                    let grid = document.getElementById('servicesGrid');

                    if (isInitial || !grid) {
                        let html = \`<div id="servicesGrid" class="grid grid-cols-1 md:grid-cols-2 gap-4 max-h-[600px] overflow-y-auto pr-2">\`;
                        data.services.forEach(s => {
                            html += renderServiceCard(s);
                        });
                        html += \`</div><div class="mt-6 flex justify-end">
                            <button onclick="document.getElementById('depositModal').classList.remove('hidden')" class="bg-emerald-600 hover:bg-emerald-500 px-6 py-3 rounded-xl font-bold text-sm"><i class="fa-solid fa-wallet mr-2"></i> Bakiye Yükle</button>
                        </div><div id="activeOrderArea" class="mt-8"></div>\`;
                        main.innerHTML = html;
                    } else {
                        // Sadece her saniye stokları ve butonları sessizce güncelle
                        data.services.forEach(s => {
                            const stockEl = document.getElementById('stock_' + s.id);
                            const btnEl = document.getElementById('btn_' + s.id);
                            if (stockEl) {
                                stockEl.innerHTML = s.stock > 0 ? \`<span class="text-emerald-400 font-bold">\${s.stock} Adet Stok</span>\` : \`<span class="text-red-400 font-bold">Stok Yok</span>\`;
                            }
                            if (btnEl && !btnEl.dataset.buying) {
                                if (s.stock <= 0) {
                                    btnEl.disabled = true;
                                    btnEl.className = "bg-slate-800 text-slate-500 px-4 py-2 rounded-xl text-xs font-bold cursor-not-allowed";
                                    btnEl.innerText = "Tükendi";
                                } else {
                                    btnEl.disabled = false;
                                    btnEl.className = "bg-emerald-600 hover:bg-emerald-500 px-4 py-2 rounded-xl text-xs font-bold shadow-lg transition";
                                    btnEl.innerText = "Numara Al";
                                }
                            }
                        });
                    }
                } catch(e) {}
            }

            function renderServiceCard(s) {
                const isOutOfStock = s.stock <= 0;
                return \`
                    <div class="bg-slate-900 border border-slate-800 p-4 rounded-2xl flex items-center justify-between shadow-xl hover:border-emerald-500/50 transition">
                        <div class="flex items-center gap-3">
                            <div class="\${s.bg} \${s.color} w-10 h-10 rounded-xl flex items-center justify-center text-lg border border-emerald-500/20">
                                <i class="fa-brands \${s.icon}"></i>
                            </div>
                            <div>
                                <h3 class="font-bold text-xs text-white">\${s.name}</h3>
                                <p class="text-emerald-400 font-bold text-xs mt-0.5">\${s.price.toFixed(2)} TL <span id="stock_\${s.id}" class="text-[10px] ml-1.5 font-mono">\${isOutOfStock ? '<span class="text-red-400 font-bold">Stok Yok</span>' : '<span class="text-emerald-400 font-bold">' + s.stock + ' Adet Stok</span>'}</span></p>
                            </div>
                        </div>
                        <button id="btn_\${s.id}" \${isOutOfStock ? 'disabled class="bg-slate-800 text-slate-500 px-4 py-2 rounded-xl text-xs font-bold cursor-not-allowed"' : \`onclick="buyNumber('\${s.serviceCode}', '\${s.country}', \${s.price}, '\${s.name}', '\${s.id}')"\` } class="\${isOutOfStock ? 'bg-slate-800 text-slate-500 cursor-not-allowed' : 'bg-emerald-600 hover:bg-emerald-500 shadow-lg transition'} px-4 py-2 rounded-xl text-xs font-bold">\${isOutOfStock ? 'Tükendi' : 'Numara Al'}</button>
                    </div>
                \`;
            }

            async function buyNumber(serviceCode, country, price, productName, cardId) {
                const btn = document.getElementById('btn_' + cardId);
                btn.dataset.buying = "true";
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Alınıyor...';

                const res = await fetch('/api/buyNumber', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ serviceCode, country, price, productName, username: currentUser })
                });
                const data = await res.json();
                delete btn.dataset.buying;
                btn.disabled = false;
                btn.innerText = 'Numara Al';

                if (data.success) {
                    fetchBalance();
                    trackOrder(data.order.activationId, data.order.phoneNumber);
                } else {
                    alert(data.message);
                }
            }

            function trackOrder(id, initialPhone) {
                if (activeTimerInterval) clearInterval(activeTimerInterval);

                let timeLeft = 600; // 10 Dakika

                document.getElementById('activeOrderArea').innerHTML = \`
                    <div class="bg-slate-900 border border-emerald-500 p-6 rounded-2xl shadow-2xl relative">
                        <h3 class="font-bold text-emerald-400 text-lg mb-3"><i class="fa-solid fa-circle-check mr-2"></i> Numara Başarıyla Alındı</h3>
                        <p class="text-sm text-slate-300">Numara: <strong class="text-white font-mono text-xl select-all">\${initialPhone}</strong></p>
                        <p class="text-sm text-slate-300 mt-2">SMS Kod: <strong id="smsCode" class="text-emerald-400 font-mono text-xl animate-pulse">Bekleniyor...</strong></p>
                        <div class="mt-4 flex items-center justify-between border-t border-slate-800 pt-4">
                            <span class="text-xs text-slate-400">Kod Süresi: <strong id="timerDisplay" class="text-amber-400 font-mono text-sm">10:00</strong></span>
                            <div id="actionButtons">
                                <button onclick="cancelOrder('\${id}')" class="bg-red-600/20 hover:bg-red-600 text-red-400 hover:text-white border border-red-500/40 px-4 py-2 rounded-xl text-xs font-bold transition">Değiştir / İptal Et</button>
                            </div>
                        </div>
                    </div>
                \`;

                activeTimerInterval = setInterval(async () => {
                    timeLeft--;
                    let min = Math.floor(timeLeft / 60);
                    let sec = timeLeft % 60;
                    const timerEl = document.getElementById('timerDisplay');
                    if (timerEl) {
                        timerEl.innerText = \`\${min.toString().padStart(2, '0')}:\${sec.toString().padStart(2, '0')}\`;
                    }

                    if (timeLeft <= 0) {
                        clearInterval(activeTimerInterval);
                        cancelOrder(id, true);
                        return;
                    }

                    try {
                        const res = await fetch(\`/api/checkSms/\${id}\`);
                        const data = await res.json();
                        if (data.success && data.status === 'completed') {
                            clearInterval(activeTimerInterval);
                            const codeEl = document.getElementById('smsCode');
                            if (codeEl) codeEl.innerText = data.code;
                            const actionArea = document.getElementById('actionButtons');
                            if (actionArea) actionArea.innerHTML = '<span class="text-emerald-400 font-bold text-xs"><i class="fa-solid fa-check"></i> Tamamlandı</span>';
                            alert("SMS Kodunuz Geldi: " + data.code);
                        }
                    } catch (e) {}
                }, 1000);
            }

            async function cancelOrder(id, isTimeout = false) {
                if (activeTimerInterval) clearInterval(activeTimerInterval);
                if (!isTimeout && !confirm("Bu numarayı iptal etmek istediğinize emin misiniz? Bakiyeniz hesabınıza iade edilecektir.")) return;

                const res = await fetch('/api/cancelNumber', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ activationId: id, username: currentUser })
                });
                const data = await res.json();
                alert(data.message);
                fetchBalance();
                document.getElementById('activeOrderArea').innerHTML = '';
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
                const username = document.getElementById('authUsername').value;
                const password = document.getElementById('authPassword').value;
                const endpoint = isRegisterMode ? '/api/auth/register' : '/api/auth/login';
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (data.success) {
                    currentUser = data.username;
                    localStorage.setItem('currentUser', currentUser);
                    closeAuthModal();
                    init();
                } else {
                    alert(data.message);
                }
            }

            async function submitDeposit() {
                const senderName = document.getElementById('depositSender').value;
                const amount = document.getElementById('depositAmount').value;
                const res = await fetch('/api/deposit/notify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: currentUser, senderName, amount })
                });
                const data = await res.json();
                alert(data.message);
                document.getElementById('depositModal').classList.add('hidden');
            }

            async function openAdminPanel() {
                const res = await fetch(\`/api/admin/getData?adminUsername=\${currentUser}\`);
                const data = await res.json();
                if (!data.success) return alert("Yetkisiz!");

                let paymentsHtml = '';
                for (let id in data.payments) {
                    let p = data.payments[id];
                    if (p.status === 'pending') {
                        paymentsHtml += \`<div class="bg-slate-950 p-4 rounded-xl mb-2 flex justify-between items-center"><span>\${p.username} - \${p.amount} TL (\${p.senderName})</span><div><button onclick="processPay('\${p.id}','approve')" class="bg-emerald-600 px-3 py-1 rounded text-xs font-bold mr-1">Onayla</button><button onclick="processPay('\${p.id}','reject')" class="bg-red-600 px-3 py-1 rounded text-xs font-bold">Reddet</button></div></div>\`;
                    }
                }

                document.getElementById('mainContent').innerHTML = \`
                    <div class="bg-slate-900 border border-amber-500/30 p-6 rounded-2xl">
                        <div class="flex justify-between items-center mb-4"><h2 class="text-xl font-bold text-amber-400">Admin Paneli</h2><button onclick="location.reload();" class="bg-slate-800 px-4 py-2 rounded-xl text-xs font-bold">Geri Dön</button></div>
                        <h3 class="font-bold mb-2">Bekleyen Ödemeler</h3>
                        \${paymentsHtml || '<p class="text-sm text-slate-500 mb-4">Bekleyen ödeme yok.</p>'}
                        <a href="/api/admin/testApi" target="_blank" class="inline-block bg-blue-600 px-4 py-2 rounded-xl text-xs font-bold text-white mt-4">API Fiyat/Stok Test Et (JSON)</a>
                    </div>
                \`;
            }

            async function processPay(paymentId, action) {
                await fetch('/api/admin/processPayment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ adminUsername: currentUser, paymentId, action })
                });
                openAdminPanel();
            }

            function logout() { 
                if (stockRefreshInterval) clearInterval(stockRefreshInterval);
                localStorage.clear(); 
                currentUser = null; 
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
    try {
        const webhookUrl = `${RENDER_EXTERNAL_URL}${webhookPath}`;
        await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
    } catch (err) {}
});
