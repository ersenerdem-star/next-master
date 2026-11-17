# Müşteri portalı kontrolü — 15 Kasım 2026

Canlı sürüm: Netlify `6af98778019fd1f71986959f`. Doğrulama, Ersen müşteri oturumuyla Chrome'da ve sınırlı, yapay test verisiyle yapıldı.

## Gerçek oturumda gözlenenler

1. Bosch fiyat listesi hazırlandı; ekranda 45.837 satır gösterildi. Kaydetme penceresi açıldı ve indirilen XLSX dosyasında 45.837 veri satırı sayıldı. `0001115022` için XLSX fiyatı €137,45; en düşük güncel alış €124,95 ve A listesi %10 kuralıyla yuvarlanmış müşteri fiyatı da €137,45. Bu örnek tek başına tüm fiyatların doğruluğunu kanıtlamaz.
2. Tek satırlık test CSV'si (Bosch `0001115022`, 3 adet) yüklendi. `PORTAL-20261115-Q78K` taslağı otomatik oluşturuldu; fiyat €137,45, toplam €412,35 idi. Taslak test amacıyla oluşturulmuştur, gönderilmemiştir.
3. İlk adet güncelleme denemesi yanlış bir eşzamanlı değişiklik hatası verdi. UTC zaman damgası karşılaştırması düzeltildi ve canlıya alındı. Aynı test taslağında 3'ten 4'e güncelleme otomatik kaydedildi; veritabanı 4 adet, aynı €137,45 satış ve €124,95 alış, €549,80 satış toplamı gösterdi.
4. Test taslağının Excel'i kaydedildi ve içeriğinde 4 adet, €137,45 birim fiyat, €549,80 satır toplamı doğrulandı. Yazdırma/PDF görünümü aynı değerleri gösterdi; gerçek PDF dosyası yazdırılmadı.

## Düzeltmeler

- Farklı UTC gösterimlerini aynı an olarak karşılaştırırken mikrosaniye seviyesindeki gerçek çakışmalar korunur.
- CSV/XLSX içindeki geçersiz, sıfır, negatif, kesirli veya sınır dışı adetler artık sessizce 1'e çevrilmez; parça numarasıyla hata gösterilir. Boş miktarın eski varsayılanı 1 korunur.
- 200 satırdan büyük yeni listelerde üç başarısız otomatik kayıt denemesi yerine, listenin dışa aktarılabileceğini ve taslak sınırını belirten uyarı gösterilir.
- Üretim derlemesi ve 23 ilgili doğrulama testi; ek olarak 201 satır uyarısının bileşen testi geçti. Ön incelemede 37 portal/fiyat/indirme testi geçti.

## Sınırlar ve öneriler

- 200 satır sınırı kullanıcı tarafından sistem yükünü korumak için özellikle belirlenmiştir; korunmalıdır. Sınırı aşan liste için açık uyarı verilir.
- Son yedi günde portal dışa aktarma işlerindeki kayıtlarda 67 başarılı, 2 başarısız işlem görüldü. Başarısızlık kodları kaynak değişimi ve kaynak kapsamı korumasıyla ilgiliydi. Başarılı ve başlangıç/bitiş zamanı olan işler ortalama 64,8 saniye sürdü; bu süre hazır dosyanın müşteriye indirilme süresi değildir. Tek indirme testi genel performans garantisi sağlamaz.
- Bazı durum mesajları Türkçe ekranda İngilizce kalıyor. Kaydetme/başarı/hata mesajları Türkçeleştirilmeli.
- Canlı satış siparişi gönderilmedi/onaylanmadı; büyük dosya yük testi, farklı müşteri yetki kombinasyonları, mobil ve gerçek çok kullanıcılı yük testi yapılmadı. Eşzamanlı kayıt ve tekrar denemeler izole testlerle doğrulandı.
- Test taslağı `PORTAL-20261115-Q78K` Ersen hesabında taslak olarak bırakılmıştır. Test Excel dosyaları kullanıcının Downloads klasöründe bulunur.

## Takip çalışması

- Bosch ve Wabco için incelenen başarısız işlerin ardından aynı markalarda başarılı hazırlamalar bulundu; kaynak değişimi ve kapsamı korumaları korunmuştur.
- Müşteri portalında adet kaydı, otomatik taslak, indirme ve adet hatası mesajlarının Türkçe karşılıkları eklendi.
- Satır birleştirme 200 satır sınırı korunarak doğrusal bir indeksle çalışır ve mevcut satır nesnelerini değiştirmez. Yerel ölçümde 200 ayrı satırın 200 defa birleştirilmesi eski örnek uygulamada 631 ms, yeni uygulamada 13 ms sürdü. Bu ölçüm ağ ve toplam kullanıcı bekleme süresini içermez.
- Portal akışları için 41 otomatik test; manuel fiyat, senkronizasyon, sınır ve arayüz mesajları için 29 test geçti. Bazı testler iki grupta da yer alır.
- Takip sürümü `6af99340585f70a5a05a05f9` canlıda doğrulandı. Gerçek oturumda test taslağı 4'ten 5 adede otomatik güncellendi; Türkçe kayıt bildirimi görüldü, €137,45 birim fiyat korundu ve €687,25 toplam veritabanında doğrulandı. Test taslağı onaylanmamıştır.
