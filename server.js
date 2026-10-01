const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Telegram ve OnaylıSMS Bilgileri
const TELEGRAM_BOT_TOKEN = '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = '8811977430';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://yenipanel.onrender.com';

const ONAYLI_SMS_API_KEY = 'osms_24a366588a5adf689da78bd656ef845effba51b53754bf57';
const ONAYLI_SMS_URL = 'https://onaylasms.com.tr/stubs/handler_api.php';

let db = {
    users: {
        "Aklomanti": { username: "Aklomanti", password: "Aklomanti", balance: 5000, role: "admin" }
    },
    // Manuel servis listesi (API'den dinamik çekilemediği durumlarda yedek olarak çalışır)
    services: [
        { id: "wa_tr", name: "WhatsApp Türkiye", price: 300.00, serviceCode: "whatsapp", country: "0", icon: "fa-whatsapp", color: "text-emerald-400", bg: "bg-emerald-500/10" },
        { id: "wa_uk", name: "WhatsApp İngiltere", price: 200.00, serviceCode: "whatsapp", country: "16", icon: "fa-whatsapp", color: "text-emerald-400", bg: "bg-emerald-500/10" },
        { id: "tg_tr", name: "Telegram Türkiye", price: 200.00, serviceCode: "telegram", country: "0", icon: "fa-telegram", color: "text-blue-400", bg: "bg-blue-500/10" },
        { id: "gg_tr", name: "Google Türkiye", price: 50.00, serviceCode: "google", country: "0", icon: "fa-google", color: "text-amber-400", bg: "bg-amber-500/10" },
        { id: "dc_tr", name: "Discord Türkiye", price: 50.00, serviceCode: "discord", country: "0", icon: "fa-discord", color: "text-indigo-400", bg: "bg-indigo-500/10" }
    ],
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

app.get('/api/getServices', (req, res) => {
    res.json({ success: true, services: db.services });
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
    } catch (e) {
        console.error("Telegram hata:", e.message);
    }

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
    if (!payment || payment.status !== 'pending') {
        return res.json({ success: false, message: "Ödeme bulunamadı." });
    }

    if (action === 'approve') {
        payment.status = 'approved';
        if (db.users[payment.username]) {
            db.users[payment.username].balance += payment.amount;
        }
        res.json({ success: true, message: "Ödeme onaylandı." });
    } else {
        payment.status = 'rejected';
        res.json({ success: true, message: "Ödeme reddedildi." });
    }
});

// --- KESİN ÇÖZÜM: GELİŞMİŞ API NUMARA ÇEKME VE TEST ROTASI ---
app.get('/api/admin/testApi', async (req, res) => {
    try {
        // Sağlayıcının fiyat/servis listesini çekerek hangi kodların geçerli olduğunu konsola basıyoruz
        const listUrl = `${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=getPrices`;
        const apiResp = await axios.get(listUrl);
        res.json({ success: true, rawApiData: apiResp.data });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

app.post('/api/buyNumber', async (req, res) => {
    const { productKey, username } = req.body;
    const service = db.services.find(s => s.id === productKey);
    const userObj = db.users[username];

    if (!userObj || !service) return res.json({ success: false, message: "Geçersiz işlem veya kullanıcı." });
    if (userObj.balance < service.price) {
        return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin." });
    }

    // Sağlayıcının farklı varyasyonlardaki servis kodlarını denemesi için dizi oluşturuyoruz
    // (Örn: Hem 'whatsapp' hem 'wa' kodlarını sırayla dener)
    const codeVariants = [service.serviceCode];
    if (service.serviceCode === 'whatsapp') codeVariants.push('wa');
    if (service.serviceCode === 'telegram') codeVariants.push('tg');

    let successOrder = null;

    for (let code of codeVariants) {
        try {
            const targetUrl = `${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=getNumber&service=${code}&country=${service.country}`;
            console.log(`[API İstek] Denenen URL: ${targetUrl}`);

            const apiResponse = await axios.get(targetUrl);
            let responseText = apiResponse.data;
            if (typeof responseText === 'object') responseText = JSON.stringify(responseText);

            console.log(`[API Yanıt] Kod (${code}):`, responseText);

            if (typeof responseText === 'string' && responseText.includes('ACCESS_NUMBER')) {
                const parts = responseText.split(':');
                const activationId = parts[1];
                const phoneNumber = parts.slice(2).join(':');

                userObj.balance -= service.price;

                successOrder = {
                    activationId,
                    productName: service.name,
                    phoneNumber,
                    code: "Bekleniyor...",
                    status: 'waiting',
                    username,
                    time: new Date().toLocaleString('tr-TR')
                };

                db.orders[activationId] = successOrder;
                break; // Başarılı olursa döngüden çık
            }
        } catch (error) {
            console.error("API Bağlantı Hatası:", error.message);
        }
    }

    if (successOrder) {
        return res.json({ success: true, order: successOrder });
    } else {
        return res.json({ 
            success: false, 
            message: "Sağlayıcı stok vermedi (NO_NUMBERS). Lütfen Render loglarını kontrol edin veya sağlayıcı bakiyenizi/servis kodunuzu doğrulayın." 
        });
    }
});

app.get('/api/checkSms/:id', async (req, res) => {
    const activationId = req.params.id;
    const order = db.orders[activationId];
    if (!order) return res.json({ success: false, message: "Sipariş bulunamadı." });

    if (order.status === 'completed') {
        return res.json({ success: true, status: 'completed', code: order.code, phoneNumber: order.phoneNumber });
    }

    try {
        const apiResponse = await axios.get(`${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=getStatus&id=${activationId}`);
        let responseText = apiResponse.data;
        if (typeof responseText === 'object') responseText = JSON.stringify(responseText);

        if (typeof responseText === 'string' && responseText.includes('STATUS_OK')) {
            const parts = responseText.split(':');
            const code = parts[1];
            order.code = code;
            order.status = 'completed';
            return res.json({ success: true, status: 'completed', code, phoneNumber: order.phoneNumber });
        } else {
            return res.json({ success: true, status: 'waiting', code: "Bekleniyor...", phoneNumber: order.phoneNumber });
        }
    } catch (error) {
        console.error("SMS Durum Sorgu Hatası:", error.message);
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
                    if (db.users[payment.username]) {
                        db.users[payment.username].balance += payment.amount;
                    }
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `✅ Ödeme Onaylandı!\nKullanıcı: ${payment.username}\nTutar: ${payment.amount} TL` });
                } else {
                    payment.status = 'rejected';
                    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: `❌ Ödeme Reddedildi!\nKullanıcı: ${payment.username}` });
                }
            }
        } else if (callbackData === 'menu_prices') {
            let priceText = "💰 **Güncel Fiyat Listemiz:**\n\n";
            db.services.forEach(s => { priceText += `• ${s.name}: *${s.price.toFixed(2)} TL*\n`; });
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { chat_id: chatId, text: priceText, parse_mode: "Markdown" });
        }
    }

    if (update.message && update.message.text) {
        const chatId = update.message.chat.id;
        const text = update.message.text.trim();
        if (text === '/start') {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                chat_id: chatId,
                text: `🤖 SMS Onay Paneline Hoş Geldiniz!\n\nAşağıdaki menüden dilediğiniz işlemi gerçekleştirebilirsiniz:`,
                reply_markup: { inline_keyboard: [[{ text: "🌐 Web Paneline Git", url: RENDER_EXTERNAL_URL }], [{ text: "💰 Fiyat Listesi", callback_data: "menu_prices" }]] }
            });
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
        <style>
            canvas { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; }
            @keyframes pulseGlow {
                0%, 100% { box-shadow: 0 0 15px rgba(16, 185, 129, 0.2); }
                50% { box-shadow: 0 0 30px rgba(16, 185, 129, 0.5); }
            }
            .vip-card { animation: pulseGlow 4s infinite; }
        </style>
    </head>
    <body class="bg-slate-950/90 text-slate-100 font-sans min-h-screen flex flex-col justify-between relative">
        <canvas id="matrixCanvas"></canvas>
        <div class="max-w-5xl mx-auto w-full p-4 relative z-10">
            <header class="flex justify-between items-center py-4 px-6 border border-emerald-500/30 mb-6 bg-slate-900/80 backdrop-blur-md rounded-2xl shadow-2xl vip-card">
                <div class="flex items-center gap-3">
                    <div class="bg-emerald-500/20 text-emerald-400 p-2.5 rounded-xl border border-emerald-500/40">
                        <i class="fa-solid fa-crown text-xl animate-bounce"></i>
                    </div>
                    <div>
                        <h1 class="text-xl font-black tracking-wider text-emerald-400">VIP SMS ONAY</h1>
                        <p class="text-[10px] text-emerald-500/80 tracking-widest font-mono">ONAYLIRESLUL SYSTEM</p>
                    </div>
                </div>
                <div id="userArea" class="flex items-center gap-4"></div>
            </header>
            <main id="mainContent"></main>
        </div>

        <!-- AUTH MODAL -->
        <div id="authModal" class="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center hidden z-50">
            <div class="bg-slate-900 border border-emerald-500/40 p-8 rounded-3xl w-full max-w-md relative shadow-2xl">
                <button onclick="closeAuthModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
                <div class="text-center mb-6">
                    <i class="fa-solid fa-shield-cat text-4xl text-emerald-400 mb-2"></i>
                    <h2 id="authTitle" class="text-2xl font-black text-white">Giriş Yap</h2>
                    <p class="text-xs text-slate-400 mt-1">VIP Güvenli Oturum Paneli</p>
                </div>
                <div class="space-y-4">
                    <input type="text" id="authUsername" placeholder="Kullanıcı Adı" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none focus:border-emerald-500 transition">
                    <input type="password" id="authPassword" placeholder="Şifre" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none focus:border-emerald-500 transition">
                    <button onclick="handleAuthSubmit()" id="authSubmitBtn" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl transition shadow-lg shadow-emerald-600/30">Giriş Yap</button>
                    <p id="authSwitchText" class="text-center text-sm text-slate-400">Hesabın yok mu? <span onclick="switchAuthMode('register')" class="text-emerald-400 cursor-pointer underline font-semibold">Kayıt Ol</span></p>
                </div>
            </div>
        </div>

        <!-- DEPOSIT MODAL -->
        <div id="depositModal" class="fixed inset-0 bg-black/85 backdrop-blur-sm flex items-center justify-center hidden z-50">
            <div class="bg-slate-900 border border-emerald-500/40 p-8 rounded-3xl w-full max-w-md relative shadow-2xl">
                <button onclick="document.getElementById('depositModal').classList.add('hidden')" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
                <h2 class="text-xl font-black mb-4 text-emerald-400 flex items-center gap-2"><i class="fa-solid fa-wallet"></i> Bakiye Yükle (IBAN)</h2>
                <div class="space-y-4 text-sm text-slate-300">
                    <div class="bg-slate-950 p-4 rounded-xl border border-emerald-500/20">
                        <p class="text-slate-500 text-xs">Banka IBAN:</p>
                        <p class="font-mono text-emerald-400 font-bold text-base select-all">TR62 0006 2000 5000 0006 8107 73</p>
                        <p class="text-slate-500 text-xs mt-2">Alıcı Ad Soyadı:</p>
                        <p class="font-bold text-white text-base">Resul Sakal</p>
                    </div>
                    <input type="text" id="depositSender" placeholder="Gönderen Ad Soyad" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none focus:border-emerald-500">
                    <input type="number" id="depositAmount" placeholder="Yatırılacak Tutar (TL)" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none focus:border-emerald-500">
                    <button onclick="submitDeposit()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded-xl transition shadow-lg shadow-emerald-600/30">Ödeme Bildirimi Gönder</button>
                </div>
            </div>
        </div>

        <script>
            const canvas = document.getElementById('matrixCanvas');
            const ctx = canvas.getContext('2d');
            function resizeCanvas() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
            window.addEventListener('resize', resizeCanvas);
            resizeCanvas();

            const letters = '01ABCDEFXYZVIP';
            const fontSize = 14;
            let columns = canvas.width / fontSize;
            let drops = [];
            for (let x = 0; x < columns; x++) drops[x] = 1;

            function drawMatrix() {
                ctx.fillStyle = 'rgba(2, 6, 23, 0.12)';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#10b981';
                ctx.font = fontSize + 'px monospace';
                for (let i = 0; i < drops.length; i++) {
                    let text = letters.charAt(Math.floor(Math.random() * letters.length));
                    ctx.fillText(text, i * fontSize, drops[i] * fontSize);
                    if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) drops[i] = 0;
                    drops[i]++;
                }
            }
            setInterval(drawMatrix, 33);

            let currentUser = localStorage.getItem('currentUser') || null;
            let currentRole = localStorage.getItem('currentRole') || 'user';
            let activeAuthMode = 'login';

            function init() { updateUserArea(); loadServices(); }

            function updateUserArea() {
                const area = document.getElementById('userArea');
                if (currentUser) {
                    area.innerHTML = \`
                        <div class="flex items-center gap-3">
                            <span class="text-sm font-medium">@<strong class="text-white">\${currentUser}</strong></span>
                            <span id="userBalance" class="bg-emerald-500/10 text-emerald-400 px-3.5 py-1.5 rounded-full text-xs font-bold border border-emerald-500/30 shadow">0.00 TL</span>
                            \${currentUser === 'Aklomanti' ? '<button onclick="openAdminPanel()" class="bg-amber-600 hover:bg-amber-500 px-3.5 py-1.5 rounded-xl text-xs font-bold transition shadow">Admin Panel</button>' : ''}
                            <button onclick="logout()" class="text-red-400 hover:text-red-300 text-sm p-2"><i class="fa-solid fa-right-from-bracket"></i></button>
                        </div>
                    \`;
                    fetchBalance();
                } else {
                    area.innerHTML = \`
                        <button onclick="openAuthModal('login')" class="bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-xl text-sm font-bold transition shadow-lg shadow-emerald-600/30">Giriş Yap</button>
                        <button onclick="openAuthModal('register')" class="bg-slate-800 hover:bg-slate-700 px-5 py-2.5 rounded-xl text-sm font-bold transition">Kayıt Ol</button>
                    \`;
                    renderHomeNotLogged();
                }
            }

            async function fetchBalance() {
                if (!currentUser) return;
                const res = await fetch(\`/api/getCustomerBalance?username=\${currentUser}\`);
                const data = await res.json();
                if (data.success) {
                    document.getElementById('userBalance').innerText = data.balance.toFixed(2) + ' TL';
                    currentRole = data.role;
                    localStorage.setItem('currentRole', data.role);
                }
            }

            async function loadServices() {
                const res = await fetch('/api/getServices');
                const data = await res.json();
                if (!currentUser) return;

                const main = document.getElementById('mainContent');
                let html = \`<div class="grid grid-cols-1 md:grid-cols-2 gap-4">\`;
                data.services.forEach(s => {
                    html += \`
                        <div class="bg-slate-900/90 backdrop-blur-md border border-slate-800 p-5 rounded-2xl flex items-center justify-between shadow-xl hover:border-emerald-500/50 transition">
                            <div class="flex items-center gap-4">
                                <div class="\${s.bg} \${s.color} w-12 h-12 rounded-xl flex items-center justify-center text-xl border border-emerald-500/20">
                                    <i class="fa-brands \${s.icon}"></i>
                                </div>
                                <div>
                                    <h3 class="font-bold text-lg">\${s.name}</h3>
                                    <p class="text-emerald-400 font-bold">\${s.price.toFixed(2)} TL</p>
                                </div>
                            </div>
                            <button id="btn_\${s.id}" onclick="buyNumber('\${s.id}')" class="bg-emerald-600 hover:bg-emerald-500 px-5 py-2.5 rounded-xl text-sm font-bold transition shadow-md shadow-emerald-600/20">Numara Al</button>
                        </div>
                    \`;
                });
                html += \`</div><div class="mt-6 flex justify-end">
                    <button onclick="document.getElementById('depositModal').classList.remove('hidden')" class="bg-emerald-600 hover:bg-emerald-500 px-6 py-3 rounded-xl font-bold text-sm transition shadow-lg shadow-emerald-600/30"><i class="fa-solid fa-wallet mr-2"></i> Bakiye Yükle</button>
                </div><div id="activeOrderArea" class="mt-8"></div>\`;
                main.innerHTML = html;
            }

            function renderHomeNotLogged() {
                document.getElementById('mainContent').innerHTML = \`
                    <div class="text-center py-20 bg-slate-900/70 backdrop-blur-md rounded-3xl border border-emerald-500/20 p-8 shadow-2xl vip-card">
                        <span class="bg-emerald-500/10 text-emerald-400 text-xs px-4 py-1.5 rounded-full border border-emerald-500/30 font-bold mb-4 inline-block">VIP SMS ONAY SİSTEMİ</span>
                        <h2 class="text-3xl font-black mb-4 text-emerald-400">Güvenli ve Hızlı OnaylıSMS Altyapısı</h2>
                        <p class="text-slate-400 max-w-md mx-auto mb-6">Tüm sosyal platformlar için anında gerçek sanal numara çekin, kodları saniyeler içinde yakalayın.</p>
                        <button onclick="openAuthModal('login')" class="bg-emerald-600 hover:bg-emerald-500 px-8 py-3.5 rounded-xl font-bold transition shadow-xl shadow-emerald-600/40">Hemen Başla</button>
                    </div>
                \`;
            }

            async function buyNumber(productKey) {
                const btn = document.getElementById('btn_' + productKey);
                const originalText = btn.innerText;
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> Stok Bekleniyor...';

                const res = await fetch('/api/buyNumber', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productKey, username: currentUser })
                });
                const data = await res.json();
                
                btn.disabled = false;
                btn.innerText = originalText;

                if (data.success) {
                    fetchBalance();
                    trackOrder(data.order.activationId, data.order.phoneNumber);
                } else {
                    alert(data.message);
                }
            }

            function trackOrder(id, initialPhone) {
                const area = document.getElementById('activeOrderArea');
                area.innerHTML = \`
                    <div class="bg-slate-900/95 backdrop-blur-md border border-emerald-500/50 p-6 rounded-2xl shadow-2xl vip-card">
                        <div class="flex items-center justify-between mb-4">
                            <h3 class="font-bold text-emerald-400 text-lg"><i class="fa-solid fa-circle-check text-emerald-400 mr-2"></i> Numara Başarıyla Yakalandı!</h3>
                            <span class="bg-emerald-500/20 text-emerald-400 text-xs px-3 py-1 rounded-full font-mono font-bold animate-pulse">AKTİF</span>
                        </div>
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div class="bg-slate-950 p-4 rounded-xl border border-slate-800">
                                <p class="text-xs text-slate-400 mb-1">Teslim Edilen Numara:</p>
                                <strong id="phoneNum" class="text-white font-mono text-xl">\${initialPhone}</strong>
                            </div>
                            <div class="bg-slate-950 p-4 rounded-xl border border-slate-800">
                                <p class="text-xs text-slate-400 mb-1">Gelen SMS Kodu:</p>
                                <strong id="smsCode" class="text-emerald-400 font-mono text-2xl animate-pulse">Bekleniyor...</strong>
                            </div>
                        </div>
                    </div>
                \`;

                const interval = setInterval(async () => {
                    const res = await fetch(\`/api/checkSms/\${id}\`);
                    const data = await res.json();
                    if (data.success && data.status === 'completed') {
                        document.getElementById('smsCode').innerText = data.code;
                        clearInterval(interval);
                        alert("SMS Kodu Başarıyla Geldi: " + data.code);
                    }
                }, 3000);
            }

            function openAuthModal(mode) {
                activeAuthMode = mode;
                document.getElementById('authTitle').innerText = mode === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
                document.getElementById('authSubmitBtn').innerText = mode === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
                document.getElementById('authModal').classList.remove('hidden');
            }

            function closeAuthModal() { document.getElementById('authModal').classList.add('hidden'); }
            function switchAuthMode(mode) { openAuthModal(mode); }

            async function handleAuthSubmit() {
                const username = document.getElementById('authUsername').value;
                const password = document.getElementById('authPassword').value;
                const endpoint = activeAuthMode === 'login' ? '/api/auth/login' : '/api/auth/register';
                const res = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();
                if (data.success) {
                    currentUser = data.username;
                    currentRole = data.role;
                    localStorage.setItem('currentUser', currentUser);
                    localStorage.setItem('currentRole', currentRole);
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
                const main = document.getElementById('mainContent');
                const res = await fetch(\`/api/admin/getData?adminUsername=\${currentUser}\`);
                const data = await res.json();
                if (!data.success) { alert("Yetkisiz erişim!"); return; }

                let paymentsHtml = '';
                for (let id in data.payments) {
                    let p = data.payments[id];
                    if (p.status === 'pending') {
                        paymentsHtml += \`
                            <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 flex justify-between items-center mb-2">
                                <div><p class="font-bold">\${p.username} - \${p.amount} TL</p><p class="text-xs text-slate-400">Gönderen: \${p.senderName}</p></div>
                                <div class="space-x-2">
                                    <button onclick="processPayment('\${p.id}', 'approve')" class="bg-emerald-600 hover:bg-emerald-500 px-3 py-1 rounded-lg text-xs font-bold">Onayla</button>
                                    <button onclick="processPayment('\${p.id}', 'reject')" class="bg-red-600 hover:bg-red-500 px-3 py-1 rounded-lg text-xs font-bold">Reddet</button>
                                </div>
                            </div>
                        \`;
                    }
                }

                let visitorsHtml = data.visitors.map(v => \`<li class="text-xs text-slate-400">\${v.ip} - \${v.time}</li>\`).join('');
                let loginsHtml = data.logins.map(l => \`<li class="text-xs text-slate-400">@\${l.username} (\${l.ip}) - \${l.time}</li>\`).join('');

                main.innerHTML = \`
                    <div class="bg-slate-900/90 backdrop-blur-md border border-amber-500/30 p-6 rounded-2xl mb-6 shadow-xl">
                        <div class="flex justify-between items-center mb-4">
                            <h2 class="text-xl font-bold text-amber-400"><i class="fa-solid fa-lock mr-2"></i> VIP Admin Paneli (Aklomanti)</h2>
                            <button onclick="loadServices()" class="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-xs font-bold">Ana Sayfaya Dön</button>
                        </div>
                        <h3 class="font-bold text-md mb-2">Bekleyen Ödemeler</h3>
                        \${paymentsHtml || '<p class="text-sm text-slate-500 mb-6">Bekleyen ödeme yok.</p>'}
                        
                        <div class="mt-4">
                            <a href="/api/admin/testApi" target="_blank" class="inline-block bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded-xl text-xs font-bold text-white shadow"><i class="fa-solid fa-code mr-1"></i> API Sağlayıcı Servis Listesini Test Et (JSON)</a>
                        </div>

                        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
                            <div class="bg-slate-950 p-4 rounded-xl border border-slate-800">
                                <h4 class="font-bold text-sm text-emerald-400 mb-2">Son Ziyaretçiler (IP)</h4>
                                <ul class="space-y-1 max-h-40 overflow-y-auto">\${visitorsHtml}</ul>
                            </div>
                            <div class="bg-slate-950 p-4 rounded-xl border border-slate-800">
                                <h4 class="font-bold text-sm text-emerald-400 mb-2">Son Giriş Yapanlar</h4>
                                <ul class="space-y-1 max-h-40 overflow-y-auto">\${loginsHtml}</ul>
                            </div>
                        </div>
                    </div>
                \`;
            }

            async function processPayment(paymentId, action) {
                const res = await fetch('/api/admin/processPayment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ adminUsername: currentUser, paymentId, action })
                });
                const data = await res.json();
                alert(data.message);
                openAdminPanel();
            }

            function logout() {
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
    console.log(`Sistem ${PORT} portunda çalışıyor.`);
    try {
        const webhookUrl = `${RENDER_EXTERNAL_URL}${webhookPath}`;
        await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
        console.log("Webhook başarıyla bağlandı:", webhookUrl);
    } catch (err) {
        console.error("Webhook bağlantı hatası:", err.message);
    }
});
