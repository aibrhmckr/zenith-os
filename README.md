# Zenith OS

Electron + React konsol arayüzü. Varsayılan dil İngilizce; Settings → Language ile Türkçe seçilebilir.

## Yerel oyun kütüphanesi

Uygulama açılırken proje kökündeki `games` klasörü oluşturulur ve doğrudan içindeki
ROM dosyaları taranır. Windows paketinde bu klasör uygulamanın/portable EXE'nin yanındadır.
Linux paketinde salt okunur AppImage veya /opt yerine userData/games kullanılır. Yeni dosyaları görmek için **Scan library** butonunu kullanın.

Desteklenen konsollar: PS2, PS1, PSP, NDS, GBA, GBC, GameCube, Wii, N64, SNES, NES,
3DS, Genesis ve Dreamcast. `.iso` dosyasının adında veya tam yolunda `PSP`
(örneğin `(PSP)`) ya da `Vice City Stories` geçiyorsa PSP kabul edilir; diğer
ISO dosyalarında varsayılan PS2'dir. Bu kontrol büyük/küçük harfe duyarlı değildir.
Uzantılar büyük/küçük harfe duyarlı değildir; alt klasörler taranmaz.

Kapak için ROM ile aynı adı kullanın: `games/Oyun.iso` ve `games/Oyun.jpg` veya
`games/Oyun.png`. İkisi de varsa JPG tercih edilir. Aynı resim arka planda da
kullanılır; indirilen Libretro kapakları varsa öncelik kazanır. Hiç resim yoksa
konsol adı gösterilir.

## Otomatik medya taraması ve önizleme

Uygulama açılışında oyunlar hemen listelenir, ardından görseller arka planda
[Libretro Thumbnail CDN](https://thumbnails.libretro.com/) üzerinden indirilir.
Ücretli servis, hesap veya API anahtarı gerekmez. `Named_Boxarts`, `Named_Snaps`
ve `Named_Titles` dizinleri konsol, temizlenmiş oyun adı ve bölgeye göre eşleştirilir.
Örneğin `New Super Mario Bros. (USA).nds`, arayüzde `New Super Mario Bros.` olarak
gösterilir; USA bilgisi eşleştirme için korunur.

Görseller `app.getPath('userData')/media/{gameId}/boxart.png`, `snap.png` ve
`title.png` dosyalarında saklanır. `userData/games.json`, oyun kimliklerini,
platform/bölge bilgisini ve yerel medya yollarını tutar. CDN yayın yılı,
geliştirici veya tür bilgisi sağlamadığı için bu alanlar `null` bırakılır.
`userData`, geliştirmede genellikle `%APPDATA%/zenith` klasörüdür.

İki paralel indirme, istek zaman aşımı ve boyut sınırları uygulanır. İnternet
kesildiğinde yerel kapaklar ve önbellek kullanılmaya devam eder. Bulunamayan
eşleşmeler 24 saat sonra yeniden kontrol edilir; yenileme butonu hemen tekrar
dener. İndirilmiş görseller tekrar indirilmez.

Ses ve video önizlemeleri [Archive.org açık JSON API](https://archive.org/developers/md-read.html)
üzerinden otomatik aranır. Hesap, API anahtarı veya ek bağımlılık gerekmez.
Müzik önce temiz oyun adıyla vgm_ost koleksiyonunda aranır. Bu koleksiyon boş
sonuç döndürürse aynı oyun adına sahip herkese açık ses kayıtları kullanılır.
Metadata dosya listesinde title/theme/menu parçası, ardından ilk uygun MP3
tercih edilir. 15–60 saniyelik parçalar önceliklidir; dosyalar kesilmez.

Video için konsolun “Video Snaps” arşivleri aranır; MP4 dosyası oyun adı ve
bölgesine göre eşleştirilir. Eşleşme yoksa aynı oyun adına sahip kısa preview,
snap veya gameplay kaydı aranır. Süresi bilinen 60 saniyeden uzun videolar
ve 5 MiB'tan büyük dosyalar indirilmez. Arşiv veya dosya bulunamazsa ilgili
medya alanı null kalır.

MP3 ve MP4, görsel taramasından bağımsız bir kuyrukta indirilir. Her istekte
(gövde aktarımı ve yönlendirmeler dahil) **15 saniye** zaman aşımı, **5 MiB**
boyut sınırı uygulanır. Ses ve video birbirini beklemez. Dosyalar doğrudan
userData altındaki oyun klasörüne stream edilir; tamamlanmamış .part dosyaları
hata durumunda temizlenir. Başarılı her dosya games.json içindeki media.music
veya media.video alanını günceller; game-media-updated IPC olayı arayüzdeki
önizlemeyi hemen yeniler.

Öncelikli ve tüm otomatik indirmeler için kullanılan yollar:

    app.getPath('userData')/media/{gameId}/theme.mp3
    app.getPath('userData')/media/{gameId}/preview.mp4

Windows'ta userData geliştirmede genellikle %APPDATA%/zenith klasörüdür.
Bu oyun klasöründeki dosyalar her zaman önceliklidir. Eski userData/media/music/{gameId}.mp3
ve userData/media/videos/{gameId}.mp4 dosyaları ikinci tercih olarak okunur.
Proje kökündeki media klasörleri artık kullanılmaz. Elle eklenen dosyalar için
bu AppData yollarını kullanıp kütüphaneyi yenileyin; gameId games.json içinde bulunur.

İndirilmiş medya tekrar indirilmez. Bulunamayan ses ve video ayrı ayrı 24 saat
sonra veya **Scan library** ile yeniden aranır. Eski sağlayıcının
başarısız arama kayıtları Archive.org denemesini geciktirmez. Ağ/erişim hataları,
bozuk yanıtlar ve eksik dosyalar arayüzü dondurmaz. Her oyun için içerik bulunması
ve harici servise kesintisiz erişim garanti değildir. Ücretsiz erişim, arşivdeki
her parçanın açık lisanslı olduğu anlamına gelmez.

Bir kart üzerinde hover, klavye veya gamepad odağı 800 ms kaldığında arka
plan kararır; varsa video döngüsü ve ses önizlemesi başlar. Ses 1,2 saniyede
en fazla %30 seviyesine yükselir. MP3 varsa video sessiz oynatılır; yoksa videonun
kendi sesi kullanılır. **Önizleme sesi** butonu sesi kapatır.
Karttan ayrılma, başka oyuna geçme, pencerenin odağını kaybetmesi, BIOS modalı
ve oyun başlatma durumlarında medya durdurulur ve başa alınır. Desteklenmeyen
codec veya oynatma engeli arayüzü kilitlemez.

Testler: `npm run test:scraper` (çevrimdışı CDN/önbellek/medya akışı) ve
`npm run test:media` (Electron içinde gecikme, ses seviyesi ve gezinme).

Ekran genişliğine uyarlanan listede ok tuşları, D-pad veya sol analog ile gezinin. Gamepad'de
LB/RB (klavyede PageUp/PageDown) konsol filtresini değiştirir, Y oyun seçeneklerini, H oyun rehberini
açar, B/Escape aramadan çıkar veya konsol menüsünü kapatır.

Üst bardaki saat sistem saatini HH:mm biçiminde her saniye yeniler. P1 rozeti
ilk bağlı gamepad'i gösterir; cihaz pil verisi sağlıyorsa yüzde, sağlamıyorsa
yeşil bağlantı göstergesi görünür. Pil yüzdesi standart Gamepad API'sinin parçası
değildir; sistemin bilgisayar pili bu gösterge için kullanılmaz.

Alt durum çubuğu, başlatma butonu ve çekmece ipuçları son kullanılan girişe göre
klavye tuşu veya renkli gamepad rozeti gösterir. Küçük analog sapmaları yok sayılır.

**X** aramayı ve sanal klavyeyi açar. İlk oyun satırında yukarı gitmek odağı
üst sınırda tutar; arama veya klavye açılmaz. Aramada gamepad **A** da sanal
klavyeyi açabilir. Sadece odaklanmak veya fareyle tıklamak OSK açmaz.
**D-pad/sol analog** harfler arasında gezer, **A** yazar, **X** siler,
**Menu/Start**, **B** veya **Escape** klavyeyi kapatır. Boşluk, Temizle ve Bitti
tuşları da vardır. Fiziksel klavyede **/** aramaya odaklanır; doğrudan metin girişi
devam eder. Arama kutusunun yanındaki rozet etkin kısayolu gösterir.
Sanal klavye açıkken kütüphane gamepad komutlarını almaz; metin taslakta tutulur
ve kapanışta uygulanır. **B/Menu/Escape** sonrası önceki oyun yeni sonuçlarda
varsa aynı karta, yoksa ilk sonuca odak dönülür. Hiç sonuç yoksa standart arama
alanı odak alır; **X** ile arama tekrar düzenlenebilir. Sol analog ve D-pad tüm
yönlerde aynı gezinme yolunu kullanır.
`npm run test:controller` bu geçişleri, canlı saat ve pil durumlarını taklit
gamepad ile gerçek Electron arayüzünde doğrular.

## Lore ve orijinal kılavuz çekmecesi

Seçili oyunda **H** veya **Y → Game Options → Guide & Lore**
sağdaki buzlu cam çekmeceyi açar. **Y/H**, **B** veya **Escape** ile kapanır.
Arama kutusunda yazılan H harfi çekmeceyi açmaz. Çekmece açıkken arka plandaki
oyun seçimi, başlatma ve konsol filtreleri giriş almaz; medya önizlemesi durur.
Kapatınca odak önceki kontrole döner.

**Lore & İpuçları** sekmesi Wikipedia'nın İngilizce REST özetini kaynak bağlantısıyla
gösterir. Yayın yılı ve geliştirici yalnızca özet metninden belirlenebiliyorsa
doldurulur. Bulunamayan alanlar tahmin edilmez. Spoiler içermeyen başlangıç
ipuçları genel, statik önerilerdir; harici bir yapay zekâ servisi kullanılmaz.

Çekmece açıkken gamepad'de yalnızca **LB/RB** sekme değiştirir.
**Sağ/sol analog Y** veya **D-pad yukarı/aşağı** içeriği yumuşak kaydırır.
**Kılavuz Kitapçığı** sekmesinde **D-pad/sol analog sol/sağ** veya **sol/sağ ok**
sayfa çevirir. Yön tuşları Lore sekmesinden çıkmaz. PageUp/PageDown uzun kaydırma
yapar; **A** odaktaki kontrolü seçer. Sayfa butonları dairesel ok ikonlarıdır.
Sekmeler fareyle veya Tab/Shift+Tab ve Enter ile de seçilebilir. İlk ve son
sayfada gezinme sınırlandırılır. Kaynak bulunamazsa “Orijinal el kitapçığı
bulunamadı” kartı gösterilir; indirilemeyen bir sayfa diğer sayfaları engellemez.

Kılavuzlar önce Archive.org `videogamemanuals`, sonuç yoksa `manuals` ve
`consolemanuals` koleksiyonlarında aynı oyun adıyla aranır. Platform ve bölge
eşleşmeleri önceliklidir; çözüm/hint/strategy kitapçıkları alınmaz. İlk sayfa
önceden, kalan sayfalar gezildikçe `userData/media/{gameId}/manual/` altında
önbelleğe alınır. `index.json` sayfa sırasını, kardeş `lore.json` Wikipedia
bilgisini saklar. Önbellekteki bilgi ve sayfalar çevrimdışı okunabilir.

İstek başına **10 saniye** zaman aşımı uygulanır. JSON/XML yanıtları 2 MiB,
sayfa görselleri 8 MiB ile sınırlandırılır; en fazla 512 sayfa listelenir.
Gecikmiş yanıtlar kapatılan çekmeceyi veya yeni seçilen sayfayı değiştirmez.

`createGuideService` içindeki `features: { manualsEnabled: true, loreEnabled: true }`
ve `setFeatures()` gelecekteki Ayarlar ekranı için hazırlanmıştır. Kapatılan
özellik ağ isteği yapmaz ve önbellekteki içeriği de göstermez. Şu anda ayrı bir
Ayarlar arayüzü eklenmemiştir.

Testler: `npm run test:guide` (sahte API, önbellek, bayraklar, zaman aşımı) ve
`npm run test:guide-ui` (Electron IPC, Y/H/B/Escape, sayfalar, odak, çevrimdışı durumlar).

## Medya depolama kuralı

Yeni medya indiricileri ana süreçte `app.getPath('userData')` ile yapılandırılmalı
ve `src/main/services/mediaPaths.js` içindeki `gameMediaDirectory(userData, gameId)`
yardımcısını kullanmalıdır. İndirilen kapak, video, müzik ve kılavuzlar yalnızca
`userData/media/{gameId}/` altında tutulur; kılavuz sayfaları `manual/` altındadır.
Proje kökü, çalışma dizini veya oyun nesnesinin `mediaDirectory` alanı indirme
hedefi olarak kullanılmaz. Ortak yardımcı mutlak userData yolu gerektirir ve
klasör dışına çıkabilen oyun kimliklerini reddeder. Önbellek yazılamıyorsa proje
dizinine geri düşülmez; isteğe bağlı medya sessizce atlanır.

`.gitignore` yerel ROM/medya/kayıt/log klasörlerini ve medya uzantılarını her
derinlikte, büyük/küçük harften bağımsız dışlar. `.md` kaynak doküman uzantısı
korunur; Genesis `.md` ROM'ları `games/` veya `roms/` içinde tutulmalıdır.
Ignore kuralları önceden izlenen dosyaları veya Git geçmişini kaldırmaz.
`npm run test:media-paths`, hedef klasörün değiştirilememesini ve gerçek Git ile
yok sayma kurallarını doğrular.

Entegrasyon testi: `npm run test:local-games`. Test, geçici bir klasör ve gizli
Electron penceresi kullanarak taramayı, kapakları, filtreleri, klavye ve simüle
edilmiş gamepad girişlerini doğrular.

## RetroArch ile oyun başlatma

RetroArch'ı proje kökünde `emulators/retroarch/retroarch.exe`, libretro DLL
dosyalarını ise `emulators/retroarch/cores/` altında bulundurun. Paketlenmiş
Windows uygulamasında `emulators` klasörü çalıştırılabilir dosyanın yanında olmalıdır.
Linux paketinde bu klasör userData altında tutulur.

Başlatma PS2, PS1, PSP, NDS, N64, GBA, SNES, NES ve Genesis için yapılandırılmıştır.
PSP, `cores/ppsspp_libretro.dll` kullanır. PS2'de `cores/pcsx2_libretro.dll`
tercih edilir; bulunamazsa `cores/lrps2_libretro.dll` kullanılır.
PS1'de `duckstation_libretro.dll` tercih edilir; bulunamazsa
`mednafen_psx_hw_libretro.dll` kullanılır. Diğer konsollar kütüphanede listelenir,
ancak başlatma için core eşleştirmesi olmadığına dair uyarı gösterilir.

Seçili oyunu **Enter**, gamepad **A** veya **Launch** butonuyla başlatın.
Arama alanında Enter, oyun başlatmaz. ROM yolu ayrı bir süreç argümanı olarak
iletilir; boşluk ve özel karakter içeren dosya adları desteklenir. RetroArch
kendi klasöründe, `-L cores/<core>.dll <oyun_yolu> -f` argümanlarıyla açılır.
RetroArch stdout/stderr çıktıları uygulamanın ana terminaline yazdırılır.

Başlatma sırasında animasyon gösterilir. Süreç açılınca uygulama gizlenir;
emülatör kapandığında tekrar öne gelir. Aynı anda yalnızca bir oyun başlatılabilir.
Eksik RetroArch, core veya ROM dosyaları ile süreç hataları kullanıcıya bildirilir.
Hata diyaloğu açılırken veya süreç kapanırken başlatma/oynama göstergesi temizlenir;
diyalog kapatıldıktan sonra yeniden başlatılabilir.
RetroArch'ın kendisini emulators/retroarch/ içine yerleştirin. Eksik çekirdekler
Zenith onay panelinden Libretro Buildbot üzerinden indirilir (Windows/Linux x64).
BIOS dosyaları indirilmez; kullanıcı kendi dökümünü seçer.

## Konsol kontrolleri ve ayarlar

| İşlem                                | Gamepad            | Klavye                                  |
| ------------------------------------ | ------------------ | --------------------------------------- |
| Oyun başlat                          | A                  | Enter                                   |
| Oyun seçenekleri / Kılavuz           | Y → Guide & Lore   | O / H                                   |
| Arama                                | X                  | /                                       |
| Filtre paneli                        | View               | F                                       |
| Konsol değiştir                      | LB / RB            | PageUp / PageDown                       |
| Ayarlar                              | Menu               | Context Menu tuşu veya Settings düğmesi |
| Oyun ekle                            | R3                 | + / Insert                              |
| Oyun sil                             | L3                 | Delete                                  |
| Geri / kapat                         | B                  | Escape                                  |
| Zenith menüsü (ana ekran / oyun içi) | View + Menu / Home | Escape / F10                            |

Medya sesini RT / M ile açıp kapatın; LT / R ile kütüphaneyi yeniden tarayın.

Arama yalnızca açık komutla açılır; ilk sırada yukarı hareket odakta kalır.
Fiziksel klavye/fare aramasında ekran klavyesi açılmaz. Ekran klavyesinde A yazar,
X siler, B/Menu kapatır ve odak oyun kartına döner. Kılavuzda LB/RB sekmeleri
sınırda durur; sağ analog/D-pad içerik kaydırır, sol/sağ kitapçık sayfasını çevirir.

### Dashboard, ses ve sanal klavye

Sağ/sol 48 px güvenli alanda 144×216 px posterler vardır. Ekrana sığan sayıda sütun
ve 16 px sabit boşluk kullanılır; kartlar sola hizalıdır. İlk satır odaktayken
yalnızca tek satır görünür; aşağı geçildiğinde vitrin 300 ms içinde iki satıra
açılır. İlk satıra dönüldüğünde kapanır. Sütunlar 8 ile sınırlanmaz: 1920 px pencerede 11, 1280 px pencerede 7 kart sığar.
Pencere daralınca kart boyutu korunur, satır başına kart sayısı azalır. D-pad/sol analog sütun sayısını
izler; alt satırlar dikey ve yumuşak kayar. Üstte yalnızca oyun adı/platform kalır.
Arka planın orta kısmı karartılmaz veya bulanıklaştırılmaz; gölge üst/alt bölgededir.

Settings → Language, A ile açılır; yukarı/aşağı seçenek seçer, A uygular, B önce
listeyi kapatır. Ayarların tamamında D-pad/sol analog ile gezilip B ile çıkılır.
Settings → Audio iki kalıcı anahtar içerir: Menu sound effects ve Video & background
preview audio. Menü efektleri `src/renderer/src/assets/sounds/` altındaki verilen
`navigate.wav`, `toggle.wav` ve `launch.wav` dosyalarını Vite ile paketler. Sentetik
ton veya WAV yükleme paneli yoktur. Menü sesleri kapalıyken gezinme ve toggle susar;
başlatma sesi ayrı çalar ve önizleme 500 ms içinde kısılır. Gezinme sesleri dört
Audio örneğiyle üst üste çalabilir. Önizleme 800 ms bekler, 400 ms içinde %30
sese ulaşır; karttan ayrılınca müzik 150 ms içinde susar. Menü sesleri varsayılan açık, video/BGM sesi kapalıdır.
Tercihler zenith-preferences yerel ayarında saklanır ve yeniden açılışta korunur.

OSK yalnızca gamepad aramasıyla açılır. iOS düzenindeki üç harf satırının sonuna
Backspace yerleşir. Küre tuşu TR/EN düzenini değiştirir; düzen tercihi saklanır.
Alt satır ?123, küre, imleç okları, geniş Space, Clear ve Search/Done içerir.
?123 / ABC harf ve sembol modlarını değiştirir; ← / → metindeki imleci taşır.
Yazma/silme seçili metni veya imlecin konumunu kullanır. B/Menu kapatır, odak
seçili oyun kartına döner. Fiziksel klavye aramasında OSK açılmaz.

### Menü & Çıkış Kombinasyonu

Settings açılınca ilk odak Language üzerindedir. Filtre paneli All consoles ile
başlar; gamepad hareketleri açık panelde kalır, B seçimi değiştirmeden karta döner.
Menu & Exit Combination satırı aktif cihazın rozetlerini gösterir. A / Enter ile
düzenleyin; yanıp sönen iki kutu sırayla iki farklı tuşu kaydeder. B / Escape
iptal eder ve eski kombinasyonu korur. Gamepad ve klavye atamaları ayrı saklanır;
userData/zenith-preferences.json ile yeniden başlatmada ve oyun içi köprüde korunur.
Varsayılan View veya Menu tek başına bırakıldığında filtre/ayar açar; birlikte
basıldığında bu eylemler sızmadan Zenith menüsü açılır. Atanan gamepad tuşlarının
Zenith tekil eylemleri kombinasyonla çakışmaması için bırakılana kadar ertelenir.

### Çekirdekler ve BIOS

Eksik çekirdek panelindeki Download core, yalnızca izin verilen DLL'i resmi
Libretro Windows/Linux x64 arşivinden indirir. ZIP CRC, boyut, PE/ELF64 başlığı ve
hedef dosya adı kontrol edilir; mevcut çekirdek üzerine yazılmaz. Sunucuda bulunmayan
çekirdek veya bağlantı hatası panelde gösterilir; RetroArch menüsüne yönlendirilmez.
PS2 için PCSX2 ardından LRPS2, PS1 için DuckStation/Beetle PSX HW/SwanStation denenir.

Settings → System & Console Status alt sayfası yalnızca kütüphanede bulunan
konsolları gösterir. Başlatmadan önce yalnızca PS2, PS1 ve Dreamcast BIOS dosyaları
denetlenir. NDS, PSP, GBA, N64 ve SNES için BIOS engeli uygulanmaz. Select / upload BIOS
kullanıcının seçtiği dosyayı ilgili RetroArch system klasörüne kopyalar:

- PS2: system/pcsx2/bios/ — 4 veya 8 MiB .bin dökümü.
- PS1: system/ — bölgeye göre scph5500.bin / scph5501.bin / scph5502.bin.
- Dreamcast: system/dc/ — dc_boot.bin.

Bu kontrol dosya adı ve boyut teşhisidir; BIOS içeriğinin doğruluğunu garanti etmez.
Aynı adlı dosyanın üzerine yazılmaz. PS2 .rom uzantısı içerik değişmeden .bin olur.
Yükleme sonrası Ready olduğunda Launch game seçeneği görünür. Delete BIOS onayı
yalnızca seçilen konsolun BIOS dosyalarını siler; ortak system klasörü korunur. Open folder
hedef klasörü Windows Gezgini'nde açar. BIOS veya ROM dağıtılmaz/indirilmez.

### Oturum ve oyun yönetimi

Oyun bağımsız spawn sürecinde çalışır; Zenith gizlenir ve süreç exit olayında geri
gelir. Her oturumun save/state dizini userData/media/{gameId}/ altında tutulur.
Windows XInput köprüsü emülatör odaktayken yapılandırılan gamepad kombinasyonunu,
Home ve klavye kısayollarını izler. Varsayılan kombinasyon View + Menu, klavye
yedekleri Escape / F10’dur. Home tuşunu Windows/kol sürücüsü sunmayabilir veya
Xbox Game Bar devralabilir. Zenith menüsünde Return to game, Stop game & return
to Zenith ve Quit to desktop bulunur; ana ekran menüsünde de uygulamadan çıkılır.
RetroArch oturum ayarlarında input_menu_toggle_gamepad_combo=0,
input_menu_toggle_btn=nul ve input_menu_toggle=nul uygulanır. Escape’in doğrudan
emülatörü kapatmaması için RetroArch çıkış atamaları da oturumda kapatılır.
RetroArch'a pause_nonactive=true verilir; menü odağında oyun duraklar. Diğer
uygulamaların/global Game Bar kısayollarının ayarları değiştirilmez.

Add game seçilen ROM/ISO dosyasını asenkron olarak merkezi games/ klasörüne
kopyalar (Linux’ta geliştirme dahil userData/games/). Kaynak dosya değiştirilmez;
aynı adlı oyun üzerine yazılmaz, yeni kopyaya numara eklenir. Kütüphane merkezi
kopyayı kullanır; masaüstündeki orijinal silinse de oyun korunur. Delete onayı
bu merkezi ROM dosyasını, kütüphane kaydını ve userData/media/{gameId}/ altındaki
medya/manual/save verilerinin tamamını kalıcı olarak siler. Eski sürümden kalan
harici referanslarda kaynak dosya korunur, yalnızca Zenith kaydı ve önbelleği kaldırılır. Onay metni kaynak ROM
silme işlemini açıkça belirtir; onaydan önce dosyalara dokunulmaz. Silme, devam eden scraper yazılarını bekler ve önbelleği kaldırır.

Dinamik medya yalnızca app.getPath('userData')/media/ altında saklanır. DLL/EXE/BIOS,
ROM ve medya kalıpları .gitignore ve dağıtım hariç tutma kurallarıyla korunur.
Yalnızca kullanıcı tarafından verilen üç uygulama WAV dosyası için dar kapsamlı
Git istisnası vardır; indirilen oyun medyası bu istisnaya girmez.
Önceden takip edilen RetroArch DLL/EXE dosyaları diskte korunarak Git indeksinden
çıkarılmıştır; geçmiş commit'ler yeniden yazılmamıştır.

Testler: npm run test:console-services, npm run test:console, npm run test:bios,
npm run test:launcher, npm run test:controller, npm run test:guide-ui,
npm run test:media. Ağ, ROM, DLL ve gamepad yanıtları sentetiktir; fiziksel kol ve
RetroArch uyumluluğu ayrıca donanım üzerinde denenmelidir.

## Yasal Uyarı / Legal Disclaimer

Zenith OS yalnızca bir arayüz ve kütüphane yönetim aracıdır.
Bu yazılım hiçbir telifli oyun ROM'u, ISO dosyası veya BIOS verisi içermez ve dağıtmaz.
Kullanıcılar yalnızca mülkiyetine sahip oldukları fiziksel oyunların ve konsol donanımlarının
yasal yedeklerini kullanmaktan kendileri sorumludur.

Launcher testi: `npm run test:launcher`. Test gerçek Electron IPC ve arayüzünü,
taklit emülatör süreci ve iletişim kutularıyla doğrular; gerçek ROM çalıştırmaz.

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```

## Windows ve Linux / Steam Deck

- Windows: npm run build:win → klasik NSIS kurulum sihirbazı (x64).
- Linux: npm run build:linux → AppImage ve deb (x64); Linux çıktıları Linux CI/host üzerinde derlenmelidir.
- Geliştirmede emulators/retroarch/retroarch.exe (Windows) veya emulators/retroarch/retroarch (Linux) kullanılır.
- Linux oyun klasörü geliştirmede de userData/games/ olur. Paketlenmiş Linux'ta emülatör klasörleri app.getPath('userData') altındadır;
  tipik yol ~/.config/zenith/emulators/retroarch/retroarch. AppImage mount dizinine yazılmaz.
- Linux RetroArch dosyasına çalıştırma izni verilmiş olmalıdır. Windows DLL'leri Linux'ta
  yüklenmez; sistemine uygun .so çekirdeği indirilir. Paketli uygulama gömülü RetroArch'ı ilk açılışta userData'ya hazırlar.
- Steam Deck'te AppImage'a çalıştırma izni verip Steam'e Steam dışı oyun olarak ekleyin;
  Steam Input için standart Gamepad düzenini kullanın. Steam/Guide tuşunu SteamOS ayırabilir.
  Linux oyun içi köprüsü sistemde Python 3 ve SDL2 varsa gamepad kombinasyonlarını
  okur; özel klavye kombinasyonları X11 gerektirir. Wayland/SteamOS masaüstü
  kısıtları bu arka plan erişimini engelleyebilir. Escape/F10 yedekleri de masaüstü
  global kısayol desteğine bağlıdır; Steam/Guide tuşunun devralınması garanti edilmez.
- Yollar path.join/path.normalize ile kurulur; Linux'ta farklı harf büyüklükleri ayrı
  dosyalardır. Yerel dosya URL'leri pathToFileURL ile oluşturulur. Vite geliştirme
  sunucusunda file:// erişim kısıtını aşmadan medya göstermek için yalnızca izin verilen
  dosyaları sunan game-media/game-cover protokolleri korunur.

npm run test:platform: Linux yol/ELF/BIOS ve Windows portable ayrımını mock ortamında test eder.
Linux/Steam Deck üzerinde gerçek donanım testi bu Windows çalışma ortamında yapılmamıştır.

Game Options yalnızca Guide & Lore ve Delete game içerir; ilk odak rehbere gider.
Game Options seçili indeksi DOM odağından ayrı tutar, yeniden açıldığında sıfırlar;
pencere odağı geri geldiğinde seçimi onarır. B kapattığında odak ilgili karta döner. Konsol filtresi sadece kütüphanedeki
konsolları ve All consoles seçeneğini gösterir; dört yönlü grid gezinmesi desteklenir.

`npm run test:import-hotkeys` merkezi kopyalama ve kombinasyon mantığını;
`npm run test:hotkeys` iki aşamalı atama/iptal, kalıcılık, ana ekran/oyun menüsü,
native köprü mesajları ve RetroArch oturum ayarlarını sentetik verilerle doğrular.

Oyun Ekle filtresi Atari .a26/.a78/.lnx, .smd/.v64 ve .bin/.rom/.atx/.zip/.7z
dosyalarını da kapsar; ikinci filtre Tüm Dosyalar’dır. Genel dump ve arşiv
uzantıları tek başına konsolu belirlemez: bu dosyalar Unassigned olarak korunur.
ZIP/7z kendiliğinden açılmaz; gerektiğinde oyun için Gözat üzerinden uygun core seçin.
Atari 2600/7800/Lynx artık Stella/ProSystem/Beetle Lynx varsayılan eşlemelerini kullanır.

## Geliştirici mimarisi ve dağıtım kontrolü

Tam dosya/IPC envanteri, Gözat çekirdek akışı, katkı ve telif sınırları için [ARCHITECTURE.md](ARCHITECTURE.md) belgesine bakın.
`npm run check:distribution` Git indeksindeki yasak runtime dosyalarını denetler;
`git config core.hooksPath .githooks` yerel pre-commit korumasını etkinleştirir.
Geçmiş commit’ler ve asset lisansları yayın öncesi ayrıca gözden geçirilmelidir.

## RetroArch: geliştirici kurulumu ve üretim paketi

```sh
npm ci
npm run setup:emulators
npm run dev
# Windows x64 kurulum sihirbazı:
npm run build:win
# Linux host, native Linux RetroArch prepared first:
npm run build:linux
```

- Windows x64 bootstrap, [resmi stable dizininden](https://buildbot.libretro.com/stable/)
  en yüksek kararlı sürümü bulur, `RetroArch.7z` arşivini akışla indirir ve
  `emulators/retroarch/` altına çıkarır. 7-Zip geliştirme bağımlılığı npm ile gelir.
  Mevcut `retroarch.exe` varsa kurulum korunur; otomatik güncelleme/üzerine yazma yapılmaz.
- Linux'ta script klasör iskeletini hazırlar ve kurulum yönergesini gösterir;
  otomatik Linux binary indirmesi yapmaz. Native x64 RetroArch ve bağımlılıklarını
  `emulators/retroarch/` içine hazırlayın; `retroarch` çalıştırılabilir olmalıdır.
  Windows üzerinde Linux paketi için Windows emülatörünü kullanmayın.
- Git yalnız iki boş `.gitkeep` dosyasını içerir. `extraResources` yerel RetroArch'ı
  `resources/emulators/retroarch/` içine, ASAR dışında paketler. BIOS/system,
  kişisel config, kayıt, ROM, önbellek ve log dizinleri pakete alınmaz.
  RetroArch'ın çalışma DLL'leri ve assets dahil edilir; lisans dosyaları korunur.
  `cores/**` paket dışında tutulur; çekirdekler kullanıcının onayıyla sonradan indirilir.
- `beforePack` hedef işletim sisteminin çalıştırılabilir dosyasını doğrular;
  eksik/yanlış kurulumla son kullanıcı paketi oluşturmayı durdurur.
- Windows ve Linux paketleri ilk açılışta RetroArch'ı
  `app.getPath('userData')/emulators/retroarch/` altına arka planda hazırlar.
  Sonraki açılışlarda yalnız eksik/boş dosyalar tamamlanır; mevcut ayarlar korunur.
  Kilitli autoconfig/CFG dosyaları loglanıp atlanır ve sonraki açılışta yeniden denenir.
  Böylece cores/BIOS yazımı Program Files veya salt okunur AppImage'a yapılmaz.
  Mevcut kullanıcı kurulumu korunur; uygulama güncellemesi onu otomatik değiştirmez.
- `npm run build` yalnız Main/Preload/Renderer derlemesidir; installer üretmez.
  Emülatör gömme işlemi `build:win`, `build:linux` ve `build:unpack` ile gerçekleşir.
- Dağıtılan RetroArch ve seçilen core'ların lisans/kaynak sağlama yükümlülükleri
  release hazırlığının parçasıdır; `.gitignore` Git koruması ile paketleme aynı şey değildir.

## Windows NSIS kurulum sihirbazı

Varsayılan Windows hedefi NSIS'tir: oneClick=false, perMachine=false,
allowToChangeInstallationDirectory=true. Masaüstü/Başlat menüsü kısayolları ve
bitişte çalıştır seçeneği açıktır; differentialPackage=false. Artifact:
dist/zenith-1.0.0-setup.exe (sürüm package.json'dan gelir).

npm run build:win kaynakları derler ve NSIS paketini oluşturur.
Yalnız paketlemek için npx electron-builder --win nsis --x64 kullanılabilir.
Portable gerektiğinde ayrıca npx electron-builder --win portable --x64 çalıştırılır.
forceCodeSigning=false ve signAndEditExecutable=false geliştirme paketlemesinde
sertifika gerektirmez; bunlar Windows güvenlik ilkesini değiştirmez.

scripts/nsis-process.cjs, mevcut beforePack doğrulamasından Windows'ta etkinleşir.
electron-builder 26.15.3 WineVmManager.exec çağrısında yalnız boş argümanlı,
RunAsInvoker ortamlı geçici EXE işlemini normalleştirir: mutlak dosya yolu,
korunan Windows ortamı (SystemRoot, PATH, TEMP), gizli yardımcı pencere.
UNKNOWN/EBUSY/EPERM/EACCES spawn hatalarını 250/750/1500/3000 ms aralıklarla
sınırlı tekrarlar; normal hata çıkış kodlarını tekrar etmez ve kalıcı hatayı
build'e geri iletir. node_modules dosyaları, NSIS cache ACL'leri ve Windows
koruma ayarları değiştirilmez. USE_SYSTEM_MAKENSIS zorlanmaz; builder'ın
kendi NSIS/compiler/plugin seti korunur.

WineVm adı Windows'ta Wine kurulduğu anlamına gelmez; bu dal doğrudan Windows
EXE'sini çalıştırır. Uninstaller üretimi, makensis çağrısından sonra geçici
kurucunun çalıştırılmasını da içerir. Yardımcı adaptör bu ayrımı hedefler;
electron-builder sürüm yükseltmelerinde tests/nsis-process.test.mjs ve gerçek
NSIS build birlikte doğrulanmalıdır. Test, ortam koruma, sınırlı tekrar ve
sihirbaz yapılandırmasını kapsar. Kalıcı işletim sistemi engelleri bypass edilmez.

## RetroArch synchronization and downloaded core files

Every launch supplies a per-game `userData/media/{gameId}/session.cfg` through
`--appendconfig` using an absolute path. It sets `video_vsync = "true"`,
`video_refresh_rate = "60.0"`, `audio_sync = "true"`, `audio_rate_control = "true"`,
`fastforward_ratio = "1.0"`, `video_max_swapchain_images = "3"`, and
`vrr_runloop_enable = "true"`. These session settings also apply to existing installations.
The configured refresh-rate value is 60.0 Hz; actual game timing still needs validation
with the core, audio driver and display in use. See the
[upstream configuration](https://github.com/libretro/RetroArch/blob/master/retroarch.cfg).

Session configuration also disables `notification_show_osd`, `notification_show_autoconfig`,
`video_osd_widgets`, `notification_show_core_load`, and the classic text OSD via
`video_font_enable`. On Windows it selects `audio_driver = "xaudio"`; Linux/Steam Deck
keeps its native audio driver. Audio is enabled and unmuted at `audio_volume = "0.0"`
(0 dB). These settings do not change the operating system's mixer or output device.

Core downloads are extracted into native Node.js Buffers and written to new temporary
files before atomic installation. On Windows, only that newly downloaded and validated
core's `Zone.Identifier` stream is removed before publication. Missing streams are normal;
other cleanup failures are reported through the download error UI. Existing manually
installed cores are not unblocked. This follows the named-stream operation described by
[Microsoft's Unblock-File documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/unblock-file).
No PowerShell process or system security-policy change is needed. Cores remain excluded
from electron-builder packages; this flow runs when the installed app downloads a core.

## Legal Disclaimer

Zenith OS is an open-source launcher and frontend interface designed for library management and emulator automation. Zenith OS does not contain, distribute, or promote any copyrighted ROMs, ISOs, game assets, or proprietary console BIOS dumps. Users are solely responsible for providing their own legally dumped games and BIOS files.

## Third-Party Licenses & Attribution

- **RetroArch & libretro:** This project utilizes the open-source RetroArch frontend under the GNU General Public License v3.0 (GPL-3.0). RetroArch and the libretro ecosystem are developed and maintained by the Libretro team and contributors; individual emulation cores also have their own upstream developers and licenses. Visit [RetroArch](https://www.retroarch.com) and [Libretro on GitHub](https://github.com/libretro) for source code and documentation.
- Core binaries are not bundled with releases and are downloaded on-demand directly by the user.
- See the [RetroArch GPL v3 license](https://github.com/libretro/RetroArch/blob/master/COPYING) and [Libretro license inventory](https://docs.libretro.com/development/licenses/) for upstream terms. Releases that include RetroArch must preserve its license notices and provide access to the corresponding source for the distributed version in accordance with GPL v3; these attribution links alone do not replace those obligations.
