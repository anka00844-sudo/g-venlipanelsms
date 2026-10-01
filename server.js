// --- ONAYLI SMS API ENTEGRASYONU (SINIRSIZ STOK YAKALAYICI DÖNGÜSÜ) ---
app.post('/api/buyNumber', async (req, res) => {
    const { productKey, username } = req.body;
    const service = db.services.find(s => s.id === productKey);
    const userObj = db.users[username];

    if (!userObj || !service) return res.json({ success: false, message: "Geçersiz işlem." });
    if (userObj.balance < service.price) {
        return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin." });
    }

    // Kullanıcı vazgeçene veya numara bulana kadar durmaksızın arar (Sonsuz Döngü)
    let attempts = 0;

    while (true) {
        attempts++;
        try {
            const targetUrl = `${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=getNumber&service=${service.serviceCode}&country=${service.country}`;
            console.log(`[Stok Denemesi #${attempts}] URL:`, targetUrl);

            const apiResponse = await axios.get(targetUrl);
            let responseText = apiResponse.data;
            console.log("API Yanıtı:", responseText);

            if (typeof responseText === 'string' && responseText.includes('ACCESS_NUMBER')) {
                const parts = responseText.split(':');
                const activationId = parts[1];
                const phoneNumber = parts[2];

                userObj.balance -= service.price;

                const order = {
                    activationId,
                    productName: service.name,
                    phoneNumber,
                    code: "Bekleniyor...",
                    status: 'waiting',
                    username,
                    time: new Date().toLocaleString('tr-TR')
                };

                db.orders[activationId] = order;
                return res.json({ success: true, order });
            }
        } catch (error) {
            console.error("OnaylıSMS API Bağlantı Hatası:", error.message);
        }

        // 2 saniyede bir tekrar dene
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
});
