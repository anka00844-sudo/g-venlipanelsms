const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');

const app = express();
app.use(bodyParser.json());

// Telegram Bot Bilgileri
const TELEGRAM_BOT_TOKEN = '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = '8811977430';
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || 'https://yenipanel.onrender.com';

// Bellek Veritabanı
let db = {
    users: {
        "admin": { username: "admin", password: "123", balance: 5000, role: "admin" }
    },
    services: [
        { id: "whatsapp", name: "WhatsApp Onay", price: 25.00, icon: "fa-whatsapp", color: "text-emerald-400", bg: "bg-emerald-500/10" },
        { id: "telegram", name: "Telegram Onay", price: 20.00, icon: "fa-telegram", color: "text-blue-400", bg: "bg-blue-500/10" },
        { id: "instagram", name: "Instagram Onay", price: 30.00, icon: "fa-instagram", color: "text-pink-400", bg: "bg-pink-500/10" },
        { id: "gmail", name: "Google / Gmail Onay", price: 15.00, icon: "fa-google", color: "text-amber-400", bg: "bg-amber-500/10" }
    ],
    payments: {},
    visitors: [],
    logins: [],
    orders: {}
};

// Ziyaretçi Takibi
app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!db.visitors.some(v => v.ip === ip)) {
        db.visitors.unshift({ ip, time: new Date().toLocaleString('tr-TR') });
        if (db.visitors.length > 50) db.visitors.pop();
    }
    next();
});

// --- API ROTALARI ---

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

// Ödeme Bildirimi & Telegram Butonlu Bildirim
app.post('/api/deposit/notify', async (req, res) => {
    const { username, senderName, amount } = req.body;
    if (!username || !senderName || !amount) return res.json({ success: false, message: "Tüm alanları doldurun." });

    const paymentId = 'pay_' + Date.now();
    db.payments[paymentId] = { id: paymentId, username, senderName, amount: parseFloat(amount), status: 'pending' };

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

// Admin İstatistikleri
app.get('/api/admin/getStats', (req, res) => {
    const { adminUsername } = req.query;
    if (db.users[adminUsername] && db.users[adminUsername].role === 'admin') {
        res.json({ success: true, visitors: db.visitors, logins: db.logins });
    } else {
        res.status(403).json({ success: false, message: "Yetkisiz." });
    }
});

app.get('/api/admin/getPendingPayments', (req, res) => {
    const { adminUsername } = req.query;
    if (db.users[adminUsername] && db.users[adminUsername].role === 'admin') {
        res.json({ success: true, payments: db.payments });
    } else {
        res.status(403).json({ success: false, message: "Yetkisiz." });
    }
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

app.post('/api/admin/directDeposit', (req, res) => {
    const { adminUsername, targetUsername, amount } = req.body;
    if (!db.users[adminUsername] || db.users[adminUsername].role !== 'admin') {
        return res.json({ success: false, message: "Yetkisiz." });
    }
    if (!db.users[targetUsername]) {
        return res.json({ success: false, message: "Kullanıcı bulunamadı." });
    }
    db.users[targetUsername].balance += parseFloat(amount);
    res.json({ success: true, message: "Bakiye eklendi." });
});

// Numara Satın Al Simülasyonu
app.post('/api/buyNumber', (req, res) => {
    const { productKey, username } = req.body;
    const service = db.services.find(s => s.id === productKey);
    const userObj = db.users[username];

    if (!userObj || !service) return res.json({ success: false, message: "Geçersiz işlem." });
    if (userObj.balance < service.price) {
        return res.json({ success: false, code: 'LOW_BALANCE', message: "Yetersiz bakiye!" });
    }

    userObj.balance -= service.price;
    const activationId = 'act_' + Date.now();
    const randomPhone = '905' + Math.floor(10000000 + Math.random() * 90000000);
    const randomCode = Math.floor(1000 + Math.random() * 9000).toString();

    const order = {
        activationId,
        productName: service.name,
        phoneNumber: randomPhone,
        code: "Bekleniyor...",
        realCode: randomCode,
        status: 'waiting',
        username
    };

    db.orders[activationId] = order;

    setTimeout(() => {
        if (db.orders[activationId]) {
            db.orders[activationId].code = randomCode;
            db.orders[activationId].status = 'completed';
        }
    }, 10000);

    res.json({ success: true, order });
});

app.get('/api/checkSms/:id', (req, res) => {
    const order = db.orders[req.params.id];
    if (!order) return res.json({ success: false, message: "Sipariş bulunamadı." });
    res.json({ success: true, status: order.status, code: order.code });
});

// Telegram Webhook Yönetimi
const webhookPath = `/api/telegram-webhook-${TELEGRAM_BOT_TOKEN}`;
app.post(webhookPath, async (req, res) => {
    const update = req.body;
    if (update.callback_query) {
        const data = update.callback_query.data;
        const chatId = update.callback_query.message.chat.id;
        const [action, paymentId] = data.split('_');

        const payment = db.payments[paymentId];
        if (payment && payment.status === 'pending') {
            if (action === 'approve') {
                payment.status = 'approved';
                if (db.users[payment.username]) {
                    db.users[payment.username].balance += payment.amount;
                }
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: `✅ Ödeme Onaylandı!\nKullanıcı: ${payment.username}\nTutar: ${payment.amount} TL`
                });
            } else if (action === 'reject') {
                payment.status = 'rejected';
                await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
                    chat_id: chatId,
                    text: `❌ Ödeme Reddedildi!\nKullanıcı: ${payment.username}`
                });
            }
        }
    }
    res.sendStatus(200);
});

// --- ARAYÜZ (FRONTEND) - TEK DOSYA İÇİNDE ---
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="tr" class="dark">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>SMS Onay Paneli</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    </head>
    <body class="bg-slate-950 text-slate-100 font-sans min-h-screen flex flex-col justify-between">
        <div class="max-w-4xl mx-auto w-full p-4">
            <!-- ÜST MENÜ -->
            <header class="flex justify-between items-center py-4 border-b border-slate-800 mb-6">
                <div class="flex items-center gap-2">
                    <i class="fa-solid fa-shield-halved text-indigo-500 text-2xl"></i>
                    <h1 class="text-xl font-bold tracking-wider">SMS ONAY</h1>
                </div>
                <div id="userArea" class="flex items-center gap-4">
                    <!-- Giriş Yap / Kayıt Ol Butonları veya Kullanıcı Bilgisi -->
                </div>
            </header>

            <!-- İÇERİK ALANI -->
            <main id="mainContent">
                <!-- Servisler ve İşlem Paneli Buraya Yüklenecek -->
            </main>
        </div>

        <!-- MODAL / GİRİŞ PENCERESİ -->
        <div id="authModal" class="fixed inset-0 bg-black/70 flex items-center justify-center hidden z-50">
            <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-md relative">
                <button onclick="closeAuthModal()" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
                <h2 id="authTitle" class="text-xl font-bold mb-4">Giriş Yap</h2>
                <div class="space-y-4">
                    <input type="text" id="authUsername" placeholder="Kullanıcı Adı" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none focus:border-indigo-500">
                    <input type="password" id="authPassword" placeholder="Şifre" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none focus:border-indigo-500">
                    <button onclick="handleAuthSubmit()" id="authSubmitBtn" class="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-semibold py-3 rounded-xl transition">Giriş Yap</button>
                    <p id="authSwitchText" class="text-center text-sm text-slate-400">Hesabın yok mu? <span onclick="switchAuthMode('register')" class="text-indigo-400 cursor-pointer underline">Kayıt Ol</span></p>
                </div>
            </div>
        </div>

        <!-- BAKIYE YÜKLEME MODALI -->
        <div id="depositModal" class="fixed inset-0 bg-black/70 flex items-center justify-center hidden z-50">
            <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl w-full max-w-md relative">
                <button onclick="document.getElementById('depositModal').classList.add('hidden')" class="absolute top-4 right-4 text-slate-400 hover:text-white"><i class="fa-solid fa-xmark text-xl"></i></button>
                <h2 class="text-xl font-bold mb-4">Bakiye Yükle (IBAN / Havale)</h2>
                <div class="space-y-4 text-sm text-slate-300">
                    <div class="bg-slate-950 p-3 rounded-xl border border-slate-800">
                        <p class="text-slate-500">Banka IBAN:</p>
                        <p class="font-mono text-white font-bold">TR33 0006 1005 9999 9999 9999 99</p>
                        <p class="text-slate-500 mt-2">Alıcı:</p>
                        <p class="font-bold text-white">SMS Onay Sistemleri A.Ş.</p>
                    </div>
                    <input type="text" id="depositSender" placeholder="Gönderen Ad Soyad" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none">
                    <input type="number" id="depositAmount" placeholder="Yatırılacak Tutar (TL)" class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-white focus:outline-none">
                    <button onclick="submitDeposit()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-3 rounded-xl transition">Ödeme Bildirimi Gönder</button>
                </div>
            </div>
        </div>

        <!-- SCRIPT -->
        <script>
            let currentUser = localStorage.getItem('currentUser') || null;
            let currentRole = localStorage.getItem('currentRole') || 'user';
            let activeAuthMode = 'login';

            function init() {
                updateUserArea();
                loadServices();
            }

            function updateUserArea() {
                const area = document.getElementById('userArea');
                if (currentUser) {
                    area.innerHTML = \`
                        <div class="flex items-center gap-3">
                            <span class="text-sm">@<strong class="text-white">\${currentUser}</strong></span>
                            <span id="userBalance" class="bg-indigo-500/10 text-indigo-400 px-3 py-1 rounded-full text-xs font-bold border border-indigo-500/20">0.00 TL</span>
                            \${currentRole === 'admin' ? '<button onclick="openAdminPanel()" class="bg-amber-600 hover:bg-amber-500 px-3 py-1 rounded-lg text-xs font-bold transition">Admin Panel</button>' : ''}
                            <button onclick="logout()" class="text-red-400 hover:text-red-300 text-sm"><i class="fa-solid fa-right-from-bracket"></i></button>
                        </div>
                    \`;
                    fetchBalance();
                } else {
                    area.innerHTML = \`
                        <button onclick="openAuthModal('login')" class="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-xl text-sm font-semibold transition">Giriş Yap</button>
                        <button onclick="openAuthModal('register')" class="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-sm font-semibold transition">Kayıt Ol</button>
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
                let html = \`
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                \`;
                data.services.forEach(s => {
                    html += \`
                        <div class="bg-slate-900 border border-slate-800 p-5 rounded-2xl flex items-center justify-between">
                            <div class="flex items-center gap-4">
                                <div class="\${s.bg} \${s.color} w-12 h-12 rounded-xl flex items-center justify-center text-xl">
                                    <i class="fa-brands \${s.icon}"></i>
                                </div>
                                <div>
                                    <h3 class="font-bold text-lg">\${s.name}</h3>
                                    <p class="text-indigo-400 font-semibold">\${s.price.toFixed(2)} TL</p>
                                </div>
                            </div>
                            <button onclick="buyNumber('\${s.id}')" class="bg-indigo-600 hover:bg-indigo-500 px-4 py-2 rounded-xl text-sm font-bold transition">Numara Al</button>
                        </div>
                    \`;
                });
                html += \`</div>
                    <div class="mt-6 flex justify-end">
                        <button onclick="document.getElementById('depositModal').classList.remove('hidden')" class="bg-emerald-600 hover:bg-emerald-500 px-6 py-3 rounded-xl font-bold text-sm transition"><i class="fa-solid fa-wallet mr-2"></i> Bakiye Yükle</button>
                    </div>
                    <div id="activeOrderArea" class="mt-8"></div>
                \`;
                main.innerHTML = html;
            }

            function renderHomeNotLogged() {
                document.getElementById('mainContent').innerHTML = \`
                    <div class="text-center py-20">
                        <h2 class="text-3xl font-extrabold mb-4">Güvenli ve Hızlı SMS Onay Hizmeti</h2>
                        <p class="text-slate-400 max-w-md mx-auto mb-6">Tüm platformlar için anında sanal numara satın alın, kodlarınızı saniyeler içinde görüntüleyin.</p>
                        <button onclick="openAuthModal('login')" class="bg-indigo-600 hover:bg-indigo-500 px-6 py-3 rounded-xl font-bold transition">Hemen Başla</button>
                    </div>
                \`;
            }

            async function buyNumber(productKey) {
                const res = await fetch('/api/buyNumber', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ productKey, username: currentUser })
                });
                const data = await res.json();
                if (data.success) {
                    fetchBalance();
                    trackOrder(data.order.activationId);
                } else {
                    alert(data.message);
                }
            }

            function trackOrder(id) {
                const area = document.getElementById('activeOrderArea');
                area.innerHTML = \`
                    <div class="bg-slate-900 border border-amber-500/30 p-6 rounded-2xl">
                        <h3 class="font-bold text-amber-400 mb-2"><i class="fa-solid fa-spinner fa-spin mr-2"></i> SMS Bekleniyor...</h3>
                        <p class="text-sm text-slate-300">Numara: <strong id="phoneNum" class="text-white font-mono text-lg">Yükleniyor...</strong></p>
                        <p class="text-sm text-slate-300 mt-1">Gelen Kod: <strong id="smsCode" class="text-emerald-400 font-mono text-xl">Bekleniyor...</strong></p>
                    </div>
                \`;

                const interval = setInterval(async () => {
                    const res = await fetch(\`/api/checkSms/\${id}\`);
                    const data = await res.json();
                    if (data.success) {
                        document.getElementById('phoneNum').innerText = data.phoneNumber || '905XXXXXXXXX';
                        if (data.status === 'completed') {
                            document.getElementById('smsCode').innerText = data.code;
                            clearInterval(interval);
                            alert("SMS Kodu Geldi: " + data.code);
                        }
                    }
                }, 3000);
            }

            function openAuthModal(mode) {
                activeAuthMode = mode;
                document.getElementById('authTitle').innerText = mode === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
                document.getElementById('authSubmitBtn').innerText = mode === 'login' ? 'Giriş Yap' : 'Kayıt Ol';
                document.getElementById('authModal').classList.remove('hidden');
            }

            function closeAuthModal() {
                document.getElementById('authModal').classList.add('hidden');
            }

            function switchAuthMode(mode) {
                openAuthModal(mode);
            }

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
                const statsRes = await fetch(\`/api/admin/getStats?adminUsername=\${currentUser}\`);
                const statsData = await statsRes.json();

                const payRes = await fetch(\`/api/admin/getPendingPayments?adminUsername=\${currentUser}\`);
                const payData = await payRes.json();

                let paymentsHtml = '';
                for (let id in payData.payments) {
                    let p = payData.payments[id];
                    if (p.status === 'pending') {
                        paymentsHtml += \`
                            <div class="bg-slate-950 p-4 rounded-xl border border-slate-800 flex justify-between items-center mb-2">
                                <div>
                                    <p class="font-bold">\${p.username} - \${p.amount} TL</p>
                                    <p class="text-xs text-slate-400">Gönderen: \${p.senderName}</p>
                                </div>
                                <div class="space-x-2">
                                    <button onclick="processPayment('\${p.id}', 'approve')" class="bg-emerald-600 hover:bg-emerald-500 px-3 py-1 rounded-lg text-xs font-bold">Onayla</button>
                                    <button onclick="processPayment('\${p.id}', 'reject')" class="bg-red-600 hover:bg-red-500 px-3 py-1 rounded-lg text-xs font-bold">Reddet</button>
                                </div>
                            </div>
                        \`;
                    }
                }

                main.innerHTML = \`
                    <div class="bg-slate-900 border border-slate-800 p-6 rounded-2xl mb-6">
                        <div class="flex justify-between items-center mb-4">
                            <h2 class="text-xl font-bold text-amber-400"><i class="fa-solid fa-lock mr-2"></i> Admin Paneli</h2>
                            <button onclick="loadServices()" class="bg-slate-800 hover:bg-slate-700 px-4 py-2 rounded-xl text-xs font-bold">Ana Sayfaya Dön</button>
                        </div>
                        <h3 class="font-bold text-md mb-2">Bekleyen Ödemeler</h3>
                        \${paymentsHtml || '<p class="text-sm text-slate-500">Bekleyen ödeme yok.</p>'}
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
    console.log(`Sıfırdan kurulan sistem ${PORT} portunda çalışıyor.`);
    try {
        const webhookUrl = `${RENDER_EXTERNAL_URL}${webhookPath}`;
        await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${webhookUrl}`);
        console.log("Telegram Webhook başarıyla bağlandı:", webhookUrl);
    } catch (err) {
        console.error("Webhook bağlantı hatası:", err.message);
    }
});
