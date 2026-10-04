const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const htmlContent = `<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Sistem Paneli</title>
    <style>
        :root {
            --primary-color: #00ff66;
            --bg-dark: #0a0a0a;
            --card-bg: rgba(15, 25, 18, 0.85);
            --text-color: #e0e0e0;
            --border-color: #00ff66;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'Courier New', Courier, monospace;
        }

        body {
            background-color: var(--bg-dark);
            color: var(--text-color);
            min-height: 100vh;
            overflow-x: hidden;
            position: relative;
        }

        #matrix-canvas {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            z-index: -1;
        }

        header {
            background: var(--card-bg);
            border-bottom: 1px solid var(--border-color);
            padding: 15px 30px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            backdrop-filter: blur(5px);
        }

        .logo {
            font-size: 1.5rem;
            font-weight: bold;
            color: var(--primary-color);
            text-shadow: 0 0 5px var(--primary-color);
        }

        nav a {
            color: var(--text-color);
            text-decoration: none;
            margin-left: 20px;
            transition: 0.3s;
        }

        nav a:hover, nav a.active {
            color: var(--primary-color);
            text-shadow: 0 0 5px var(--primary-color);
        }

        .main-container {
            max-width: 1100px;
            margin: 40px auto;
            padding: 0 20px;
        }

        .section-title {
            color: var(--primary-color);
            margin-bottom: 20px;
            text-transform: uppercase;
            letter-spacing: 2px;
            text-shadow: 0 0 5px var(--primary-color);
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 10px;
        }

        .products-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 50px;
        }

        .product-card {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 20px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
            backdrop-filter: blur(5px);
            transition: 0.3s;
        }

        .product-card:hover {
            box-shadow: 0 0 15px rgba(0, 255, 102, 0.3);
            transform: translateY(-3px);
        }

        .product-title {
            font-size: 1.1rem;
            color: var(--primary-color);
            margin-bottom: 10px;
        }

        .product-desc {
            font-size: 0.85rem;
            color: #aaa;
            margin-bottom: 15px;
        }

        .product-price {
            font-size: 1.2rem;
            font-weight: bold;
            color: #fff;
            margin-bottom: 15px;
        }

        .balance-container {
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 25px;
            max-width: 600px;
            margin: 0 auto 50px auto;
            backdrop-filter: blur(5px);
        }

        .form-group {
            margin-bottom: 15px;
        }

        label {
            display: block;
            margin-bottom: 5px;
            color: var(--primary-color);
            font-size: 0.9em;
        }

        input[type="text"], input[type="number"] {
            width: 100%;
            padding: 10px;
            background: rgba(0, 0, 0, 0.7);
            border: 1px solid var(--border-color);
            color: #fff;
            border-radius: 4px;
            outline: none;
        }

        input:focus {
            box-shadow: 0 0 8px var(--primary-color);
        }

        .btn {
            width: 100%;
            padding: 12px;
            background: transparent;
            color: var(--primary-color);
            border: 1px solid var(--primary-color);
            font-weight: bold;
            cursor: pointer;
            transition: 0.3s;
            border-radius: 4px;
            text-transform: uppercase;
        }

        .btn:hover {
            background: var(--primary-color);
            color: #000;
            box-shadow: 0 0 10px var(--primary-color);
        }
    </style>
</head>
<body>

    <canvas id="matrix-canvas"></canvas>

    <header>
        <div class="logo">PANEL V1.0</div>
        <nav>
            <a href="#urunler" class="active">Ürünler</a>
            <a href="#bakiye">Bakiye Yükle</a>
        </nav>
    </header>

    <div class="main-container">
        
        <h2 id="urunler" class="section-title">Ürünler & Hizmetler</h2>
        <div class="products-grid">
            <div class="product-card">
                <div>
                    <div class="product-title">VIP Üyelik - 1 Ay</div>
                    <div class="product-desc">Sistemdeki tüm ayrıcalıklara 30 gün boyunca erişim sağlar.</div>
                </div>
                <div>
                    <div class="product-price">150.00 TL</div>
                    <button class="btn">Satın Al</button>
                </div>
            </div>

            <div class="product-card">
                <div>
                    <div class="product-title">Premium Paket</div>
                    <div class="product-desc">Gelişmiş araçlar ve öncelikli destek seçeneği içerir.</div>
                </div>
                <div>
                    <div class="product-price">300.00 TL</div>
                    <button class="btn">Satın Al</button>
                </div>
            </div>

            <div class="product-card">
                <div>
                    <div class="product-title">Özel Lisans Key</div>
                    <div class="product-desc">Sınırsız kullanım hakkı tanıyan tek seferlik anahtar.</div>
                </div>
                <div>
                    <div class="product-price">500.00 TL</div>
                    <button class="btn">Satın Al</button>
                </div>
            </div>
        </div>

        <h2 id="bakiye" class="section-title">Bakiye Yükle</h2>
        <div class="balance-container">
            <form action="/bakiye-yukle" method="POST">
                <div class="form-group">
                    <label for="fullname">Ad Soyad</label>
                    <input type="text" id="fullname" name="fullname" placeholder="Adınızı ve soyadınızı girin" required>
                </div>

                <div class="form-group">
                    <label for="iban">IBAN Numarası</label>
                    <input type="text" id="iban" name="iban" placeholder="TR00 0000 0000 0000 0000 0000 00" required>
                </div>

                <div class="form-group">
                    <label for="amount">Yüklenecek Tutar (TL)</label>
                    <input type="number" id="amount" name="amount" placeholder="0.00" step="0.01" required>
                </div>

                <button type="submit" class="btn">Bakiye Yükleme Talebi Oluştur</button>
            </form>
        </div>

    </div>

    <script>
        const canvas = document.getElementById('matrix-canvas');
        const ctx = canvas.getContext('2d');

        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;

        const katakana = 'アァカサタナハマヤャラワガザダバパイィキシチニヒミリヰギジヂビピウゥクスツヌフムユュルグズブヅプエェケセテネヘメレヱゲゼデベペオォコソトノホモヨョロヲゴゾドボポヴッン';
        const latin = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const alphabet = katakana + latin;

        const fontSize = 16;
        const columns = canvas.width / fontSize;
        const rainDrops = [];

        for (let x = 0; x < columns; x++) {
            rainDrops[x] = 1;
        }

        const draw = () => {
            ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);

            ctx.fillStyle = '#00ff66';
            ctx.font = fontSize + 'px monospace';

            for (let i = 0; i < rainDrops.length; i++) {
                const text = alphabet.charAt(Math.floor(Math.random() * alphabet.length));
                ctx.fillText(text, i * fontSize, rainDrops[i] * fontSize);

                if (rainDrops[i] * fontSize > canvas.height && Math.random() > 0.975) {
                    rainDrops[i] = 0;
                }
                rainDrops[i]++;
            }
        };

        setInterval(draw, 30);

        window.addEventListener('resize', () => {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        });
    </script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(htmlContent);
});

app.post('/bakiye-yukle', (req, res) => {
    const { fullname, iban, amount } = req.body;
    console.log(`Bakiye talebi: ${fullname} | ${iban} | ${amount} TL`);
    res.send(`<h2 style="color:#00ff66; background:#0a0a0a; padding:50px; text-align:center; font-family:monospace;">Talebiniz alındı! <br><br><a href="/" style="color:#fff;">Geri Dön</a></h2>`);
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
