// --- ONAYLI SMS API ENTEGRASYONU (GÜNCELLENMİŞ VE KİLİTLENMEYEN YAPI) ---
app.post('/api/buyNumber', async (req, res) => {
    const { productKey, username } = req.body;
    const service = db.services.find(s => s.id === productKey);
    const userObj = db.users[username];

    if (!userObj || !service) return res.json({ success: false, message: "Geçersiz işlem." });
    if (userObj.balance < service.price) {
        return res.json({ success: false, message: "Yetersiz bakiye! Lütfen bakiye yükleyin." });
    }

    let maxAttempts = 3; // Sistemi ve sunucuyu yormamak için maksimum 3 kez denetleyelim
    let attempts = 0;

    while (attempts < maxAttempts) {
        attempts++;
        try {
            const targetUrl = `${ONAYLI_SMS_URL}?api_key=${ONAYLI_SMS_API_KEY}&action=getNumber&service=${service.serviceCode}&country=${service.country}`;
            console.log(`[Stok Denemesi #${attempts}] Servis: ${service.serviceCode} Ülke: ${service.country} URL:`, targetUrl);

            const apiResponse = await axios.get(targetUrl);
            let responseText = apiResponse.data;
            console.log("API Ham Yanıtı:", responseText);

            if (typeof responseText === 'string') {
                if (responseText.includes('ACCESS_NUMBER')) {
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
                } else if (responseText.includes('NO_NUMBERS')) {
                    console.log(`Stok yok (NO_NUMBERS), tekrar deneniyor... (${attempts}/${maxAttempts})`);
                } else if (responseText.includes('BAD_KEY') || responseText.includes('ERROR_SQL')) {
                    return res.json({ success: false, message: "API Anahtarı veya Sağlayıcı Hatası: " + responseText });
                }
            }
        } catch (error) {
            console.error("OnaylıSMS API Bağlantı Hatası:", error.message);
        }

        // Her deneme arasında 2 saniye bekleyelim
        if (attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Eğer 3 denemede de numara düşmediyse döngüden çık ve kullanıcıya bildir
    return res.json({ 
        success: false, 
        message: "Şu anda bu servis için aktif numara stoğu bulunamadı (NO_NUMBERS). Lütfen birkaç dakika sonra tekrar deneyin veya farklı bir ülke/servis seçin." 
    });
});
