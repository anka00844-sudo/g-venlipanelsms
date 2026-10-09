const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(bodyParser.json());

const APP_VERSION = '2026-10-09-FULL-PANEL-V1';

// ====== AYARLAR ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8950975662:AAGVS-pPNJYWpxYjSLyJIXTEDBn0mD5y8XY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '8811977430';
const ONAYLI_SMS_API_KEY = process.env.ONAYLI_SMS_API_KEY || 'osms_7f193a3fe65448a9380061c1b56e9fdc29f49c67e89eb3dd';
const ONAYLI_SMS_URL = 'https://onaylasms.com.tr/stubs/handler_api.php';

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'Aklomanti';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'AZC.anka.34';

// ====== GÜVENLİK VE HASH FONKSİYONLARI ======
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha256').toString('hex');
    return { salt, hash };
}

function verifyPassword(password, salt, storedHash) {
    const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha256').toString('hex');
    return hash === storedHash;
}

// ====== SAĞLAYICI KUYRUĞU ======
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

const freshAdminPass = hashPassword(ADMIN_PASSWORD);
const DEFAULT_DB = {
    users: {
        [ADMIN_USERNAME]: {
            username: ADMIN_USERNAME,
            salt: freshAdminPass.salt,
            passwordHash: freshAdminPass.hash,
            balance: 5000,
            role: "admin",
            status: "approved",
            banned: false
        }
    },
    payments: {},
    visitors: [],
    logins: [],
    orders: {},
    support: {}
};

const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'anka_data.json');
let db = DEFAULT_DB;
try {
    if (fs.existsSync(DB_FILE)) {
        const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = Object.assign({}, DEFAULT_DB, loaded);
        for (const k in DEFAULT_DB) if (db[k] === undefined) db[k] = DEFAULT_DB[k];
        if (!db.users || !Object.keys(db.users).length) db.users = DEFAULT_DB.users;
    }
} catch (e) { console.error('[db] Yükleme hatası:', e.message); }

db.users[ADMIN_USERNAME] = Object.assign(
    { balance: 5000 },
    db.users[ADMIN_USERNAME] || {},
    {
        username: ADMIN_USERNAME,
        salt: freshAdminPass.salt,
        passwordHash: freshAdminPass.hash,
        role: 'admin',
        status: 'approved',
        banned: false
    }
);

let saveTimer = null;
function persist() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db)); } catch (e) { console.error('[db] Diske yazma hatası:', e.message); }
    }, 400);
}

// ====== ADMIN OTURUM DOKUSU ======
let adminSessions = {}; 
function createAdminSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions[token] = { username, ts: Date.now() };
    return token;
}

function checkAdminToken(token) {
    const sess = token && adminSessions[token];
    if (!sess) return null;
    if (Date.now() - sess.ts > 2 * 60 * 60 * 1000) { delete adminSessions[token]; return null; }
    if (!db.users[sess.username] || db.users[sess.username].role !== 'admin') return null;
    return sess.username;
}

// ====== ZİYARETÇİ TAKİBİ ======
app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    if (!db.visitors.some(v => v.ip === ip)) {
        db.visitors.unshift({ ip, time: new Date().toLocaleString('tr-TR'), path: req.path });
        if (db.visitors.length > 150) db.visitors.pop();
    }
    next();
});

// ====== KULLANICI GİRİŞİ ======
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    const user = db.users[username];

    if (!user) return res.json({ success: false, message: "Hatalı kullanıcı adı veya şifre!" });

    const isValid = user.salt 
        ? verifyPassword(password, user.salt, user.passwordHash)
        : user.password === password;

    if (isValid) {
        if (user.banned) return res.json({ success: false, message: "Hesabınız yasaklandı." });
        if (user.status === 'pending') return res.json({ success: false, message: "Üyeliğiniz henüz admin tarafından onaylanmadı." });
        if (user.status === 'rejected') return res.json({ success: false, message: "Üyelik başvurunuz reddedildi." });

        const adminToken = user.role === 'admin' ? createAdminSession(username) : null;
        res.json({ success: true, username, role: user.role, adminToken });
    } else {
        res.json({ success: false, message: "Hatalı kullanıcı adı veya şifre!" });
    }
});

// ====== TELEGRAM VE YÖNETİCİ ONAYLI KAYIT SİSTEMİ ======
app.post('/api/auth/register', async (req, res) => {
    const { username, password, phone, telegramUsername } = req.body;

    if (!username || !password || !phone || !telegramUsername) {
        return res.json({ success: false, message: "Tüm alanlar (Kullanıcı Adı, Şifre, Telefon, Telegram) zorunludur." });
    }

    if (db.users[username]) return res.json({ success: false, message: "Bu kullanıcı adı zaten alınmış." });

    let cleanTg = telegramUsername.trim();
    if (!cleanTg.startsWith('@')) cleanTg = '@' + cleanTg;
    if (cleanTg.length < 5 || cleanTg.includes(' ')) {
        return res.json({ success: false, message: "Geçerli bir Telegram kullanıcı adı giriniz (Örn: @kullanici)." });
    }

    const passData = hashPassword(password);
    db.users[username] = {
        username,
        phone,
        telegramUsername: cleanTg,
        salt: passData.salt,
        passwordHash: passData.hash,
        balance: 0,
        role: "user",
        status: "pending",
        banned: false,
        registeredAt: new Date().toLocaleString('tr-TR')
    };
    persist();

    try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: ADMIN_CHAT_ID,
            text: `🚨 **YENİ ÜYELİK BAŞVURUSU**\n\n👤 **Kullanıcı Adı:** ${username}\n📞 **Telefon:** ${phone}\n✈️ **Telegram:** ${cleanTg}\n📅 **Tarih:** ${db.users[username].registeredAt}`,
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: "✅ Kaydı Onayla", callback_data: `user_approve|${username}` },
                    { text: "❌ Reddet", callback_data: `user_reject|${username}` }
                ]]
            }
        });
    } catch (e) {
        console.error('[Telegram Bot] Mesaj gönderme hatası:', e.message);
    }

    res.json({ success: true, message: "Kayıt talebiniz alındı! Admin onayından sonra giriş yapabilirsiniz." });
});

// ====== TELEGRAM BOT WEBHOOK ======
app.post(`/telegram/webhook`, (req, res) => {
    const update = req.body;
    if (update && update.callback_query) {
        const query = update.callback_query;
        const [action, payload] = (query.data || '').split('|');

        if (action === 'user_approve' && db.users[payload]) {
            db.users[payload].status = 'approved';
            persist();
            axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: query.id, text: `${payload} onaylandı.` });
            axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `✅ **ONAYLANDI**\n\nKullanıcı: ${payload}` });
        } else if (action === 'user_reject' && db.users[payload]) {
            db.users[payload].status = 'rejected';
            persist();
            axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, { callback_query_id: query.id, text: `${payload} reddedildi.` });
            axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, { chat_id: query.message.chat.id, message_id: query.message.message_id, text: `❌ **REDDEDİLDİ**\n\nKullanıcı: ${payload}` });
        }
    }
    res.sendStatus(200);
});

// ====== ADMIN ENDPOINTLERİ ======
app.get('/api/admin/getData', (req, res) => {
    const { adminToken } = req.query;
    if (!checkAdminToken(adminToken)) return res.status(403).json({ success: false, message: "Yetkisiz erişim." });

    const users = Object.values(db.users).map(u => ({
        username: u.username,
        phone: u.phone || '-',
        telegramUsername: u.telegramUsername || '-',
        balance: u.balance,
        role: u.role,
        status: u.status || 'approved',
        registeredAt: u.registeredAt || '-'
    }));

    res.json({
        success: true,
        users,
        payments: Object.values(db.payments),
        logins: db.logins.slice(0, 100),
        orders: Object.values(db.orders).slice(0, 100),
        visitors: db.visitors.length
    });
});

// ====== ANA SAYFA ARAYÜZÜ (Cannot GET / Hatasını Çözen Bölüm) ======
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
                <input id="l_user" type="text" placeholder="Kullanıcı Adı" class="w-full mb-3 p-3 rounded bg-slate-700 border border-slate-600">
                <input id="l_pass" type="password" placeholder="Şifre" class="w-full mb-4 p-3 rounded bg-slate-700 border border-slate-600">
                <button onclick="login()" class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold py-3 rounded">Giriş Yap</button>
                <p class="mt-4 text-sm text-center text-slate-400">Hesabın yok mu? <a href="#" onclick="toggleForm()" class="text-blue-400 underline">Kayıt Ol</a></p>
            </div>

            <!-- Kayıt Formu -->
            <div id="registerForm" class="hidden">
                <h2 class="text-lg font-semibold mb-4 text-slate-300">Kayıt Ol (Admin Onaylı)</h2>
                <input id="r_user" type="text" placeholder="Kullanıcı Adı" class="w-full mb-3 p-3 rounded bg-slate-700 border border-slate-600">
                <input id="r_pass" type="password" placeholder="Şifre" class="w-full mb-3 p-3 rounded bg-slate-700 border border-slate-600">
                <input id="r_phone" type="text" placeholder="Telefon Numarası" class="w-full mb-3 p-3 rounded bg-slate-700 border border-slate-600">
                <input id="r_tg" type="text" placeholder="Telegram Kullanıcı Adı (@kullanici)" class="w-full mb-4 p-3 rounded bg-slate-700 border border-slate-600">
                <button onclick="register()" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3 rounded">Kayıt Başvurusu Yap</button>
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
                el.className = 'p-3 mb-4 rounded text-sm text-center ' + (success ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400');
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
                    if(data.role === 'admin') alert("Admin Token Alındı: " + data.adminToken);
                } else {
                    showMsg(data.message, false);
                }
            }

            async function register() {
                const username = document.getElementById('r_user').value;
                const password = document.getElementById('r_pass').value;
                const phone = document.getElementById('r_phone').value;
                const telegramUsername = document.getElementById('r_tg').value;

                const res = await fetch('/api/auth/register', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({ username, password, phone, telegramUsername })
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
