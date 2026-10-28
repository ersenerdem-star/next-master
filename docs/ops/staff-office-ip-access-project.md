# Personel Ofis IP Erişimi ve Bölüm Ekranları

**Durum:** Veritabanı koruması 28 Ekim 2026'da üretime uygulandı; kayıtlı personel/IP kuralı sayısı 0. UI ve Netlify işlevleri henüz dağıtılmadı. Süper admin, dağıtım sonrası Ayarlar > Kullanıcılar bölümünde ofis bağlantısının IP'lerini kendisi ekleyebilecek.

## Amaç

Süper yöneticinin seçtiği satış ve satın alma personeli, yönetim uygulamasına ve yetkili olduğu verilere yalnızca ofisin onaylı internet çıkış IP adreslerinden erişebilsin. Admin ve süper admin hesapları bu personel kuralına otomatik olarak dahil edilmesin.

## Mevcut durum (28 Ekim 2026 incelemesi)

- Kullanıcıların `role`, `department` ve ayrı izinleri bulunuyor. Satış ve satın alma personeli aynı uygulamada yetkisine göre filtrelenen menüleri kullanıyor; bu bölümlere özel bağımsız çalışma ekranı henüz tasarlanmadı.
- Süper admin, Ayarlar > Kullanıcılar bölümünde departman ve işlem izinlerini seçebiliyor. Satın alma ayrı bir rol değil, `purchasing` departmanı ve ilgili izinlerle tanımlanıyor.
- Personel için ofis IP kuralı bulunmuyor. Depo partner API'sindeki IP izin listesi personel oturumlarına uygulanmıyor.
- Giriş ve bazı veri istekleri tarayıcıdan doğrudan Supabase'e gidiyor. Bu nedenle yalnızca arayüz veya giriş sayfasında IP kontrolü yeterli değil; mevcut oturumlar ve doğrudan veri API erişimi de kapsanmalı.

## Uygulama kapsamı

1. Süper adminin kullanıcı bazında **Yalnızca ofis ağından erişim** ayarını yönetmesi; varsayılan değer kapalı olsun. Satış ve satın alma departmanındaki seçili personel hedeflensin.
2. IT'nin verdiği onaylı genel IPv4/IPv6 çıkış IP adresleri veya dar CIDR aralıkları güvenli yapılandırmada saklansın. IP değişikliği ve yedek bağlantı için yönetilebilir süreç sağlansın. IP listesi kaynak koda yazılmasın.
3. Seçili personel için giriş, oturum yenileme ve veri/API işlemlerinde güvenilir istemci IP'si sunucu tarafında doğrulansın. Uygulamanın doğrudan Supabase erişimleri bu kuralı aşamasın; uygulanacak veri yolu ve yetki politikası tasarım aşamasında kesinleştirilsin.
4. Ofis dışından erişimde açık Türkçe hata mesajı gösterilsin; başarısız denemeler kullanıcı, zaman ve IP ile denetim kaydına alınsın. IP adresleri ve loglar yalnızca yetkili yöneticilere gösterilsin.
5. Satış ve satın alma personelinin menüleri ile gerçek API yetkileri birlikte test edilsin. Gerekirse bu bölümlerin günlük işlerine uygun ayrı çalışma ekranı tasarlansın; ekranın kapsamı personel iş akışlarıyla netleştirilsin.

## Devreye alma koşulları

- IT'den ofisin **genel çıkış IP adresleri**, varsa IPv6, yedek internet ve kurumsal VPN çıkış IP'leri alınacak; sabit olup olmadıkları doğrulanacak.
- Kısıt uygulanacak kullanıcı hesapları süper admin tarafından seçilecek.
- Ofis içi izinli, ofis dışı yasak, mevcut oturum, doğrudan API denemesi, farklı tarayıcı ve yedek hat senaryoları doğrulanacak.
- Önce tek pilot personelde açılıp doğrulandıktan sonra seçili personele genişletilecek. Acil durum için süper admin tarafından geri alma yolu hazır olacak.
- Supabase'in yönettiği `cf-connecting-ip` başlığının mevcut üretim alan adında istemci tarafından taklit edilemediği pilotta doğrulanacak. `x-forwarded-for` güvenlik kararı için kullanılmayacak.
- Supabase Data API ön istek kancası, REST/RPC, GraphQL/Realtime ve Storage yollarında izinli/yasak IP davranışı test edilecek. Katalog Storage erişimi admin/süper admin ile sınırlı; tedarikçi fiyatı Storage politikasında personel izin kontrolü ofis kuralına bağlandı. Yeni Storage politikaları eklenirse kapsam yeniden gözden geçirilecek.

## Hazırlanan teknik değişiklikler

- `staff_office_access`: kişi bazında etkin/pasif bayrağı ve en fazla 12 tam IPv4/IPv6 adresi; boş IP ile etkinleşemez. Tabloya tarayıcıdan erişim izni verilmez.
- Süper admin kullanıcı düzenleme ekranında ofis ağı seçeneği ve IP alanı. Yeni ve mevcut kullanıcıda varsayılan pasif.
- Netlify oturum ve yönetim API'lerinde güvenilir `Context.ip` kontrolü; Supabase REST/RPC için ön istek kancası; mevcut public RLS tabloları ve personel izin fonksiyonu için ek koruma.
- Ofis dışı kullanıcıya Türkçe 403 mesajı; açık oturumda ağ değişirse uygulamadan çıkış.
- Süper admin, ofisteyken uygulama ve veri API'sinin gördüğü genel IP'leri tek düğmeyle listeye ekleyebilir; kullanıcı bazında etkinleştirmeyi kendisi yönetir.
- Üretim veritabanında izinli ve yasak IP SQL kontrolleri geçmiştir; sahte `CF-Connecting-IP` başlığı Supabase girişinde HTTP 403 almıştır. İlk gerçek personel hesabı pilot olarak izlenecektir.

**Not:** Supabase Network Restrictions yalnızca Postgres/pooler bağlantılarını sınırlar; Auth, PostgREST ve `supabase-js` HTTPS isteklerini kapsamaz. Bu ayar personel IP kuralının yerine kullanılmayacak. Kaynak: https://supabase.com/docs/guides/platform/network-restrictions
