<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Panel</title>
    <style>
        :root {
            --primary-color: #00ff66; /* Sarı yerine Yeşil tema */
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
            display: flex;
            justify-content: center;
            align-items: center;
            overflow-x: hidden;
            position: relative;
        }

        /* Matrix Arka Plan Canvas */
        #matrix-canvas {
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            z-index: -1;
        }

        .container {
            width: 100%;
            max-width: 500px;
            padding: 20px;
            background: var(--card-bg);
            border: 1px solid var(--border-color);
            box-shadow: 0 0 15px rgba(0, 255, 102, 0.2);
            border-radius: 8px;
            backdrop-filter: blur(5px);
        }

        h2 {
            color: var(--primary-color);
            text-align: center;
            margin-bottom: 20px;
            text-transform: uppercase;
            letter-spacing: 2px;
            text-shadow: 0 0 5px var(--primary-color);
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

    <div class="container">
        <h2>Bakiye Yükle</h2>
        <form>
            <div class="form-group">
                <label for="fullname">Ad Soyad</label>
                <input type="text" id="fullname" placeholder="Adınızı ve soyadınızı girin">
            </div>

            <div class="form-group">
                <label for="iban">IBAN Numarası</label>
                <input type="text" id="iban" placeholder="TR00 0000 0000 0000 0000 0000 00">
            </div>

            <div class="form-group">
                <label for="amount">Yüklenecek Tutar (TL)</label>
                <input type="number" id="amount" placeholder="0.00">
            </div>

            <button type="submit" class="btn">Bakiye Yükleme Talebi Oluştur</button>
        </form>
    </div>

    <script>
        // Matrix Yağmuru Efekti
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
</html>
