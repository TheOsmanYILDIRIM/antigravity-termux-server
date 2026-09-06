# ⚡ Antigravity Termux Server & Filesystem Bridge

[![Termux](https://img.shields.io/badge/Platform-Termux%20%7C%20Android-green.svg)](https://termux.dev/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B%20(Zero--Dependency)-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Companion](https://img.shields.io/badge/Companion%20App-Antigravity%20Android-purple.svg)](https://github.com/TheOsmanYILDIRIM/antigravity-android)

Android cihazınızda Termux ortamında çalışan; [Antigravity AI Android Uygulaması](https://github.com/TheOsmanYILDIRIM/antigravity-android) için yerel dosya sistemi köprüsü, gerçek model sağlayıcısı, SSE akış yöneticisi ve otonom CI/CD gözlemcisi sağlayan ultra hafif sunucu katmanı.

---

## 🧭 Neden Bu Köprüye İhtiyaç Var? (Android Sandbox Kısıtı)

Android işletim sistemi güvenlik mimarisinde her uygulama izole bir Linux UID'si (`u0_aXXX`) altında çalışır. Termux dizini (`/data/data/com.termux/files/`) `0700` izinlerine sahip olduğundan, root yetkisi olmayan hiçbir Android uygulaması Termux dosya sistemine doğrudan erişemez.

**Antigravity Termux Server**, `127.0.0.1:8080` üzerinde çalışan sıfır bağımlılıklı (zero-dependency) bir HTTP REST + SSE sunucusu kurarak bu sorunu çözer:
- Android uygulaması yerel ağ (localhost) üzerinden Termux dosyalarını listeler, okur, düzenler ve kaydeder.
- Termux CLI komutlarını ve AI oturumlarını yönetir.
- Android uygulamasının gerçek yapay zeka model listesine anında erişmesini sağlar.

```
┌───────────────────────────────────────────────────────────┐
│           Antigravity AI (Android Native App)             │
│        Jetpack Compose • Material 3 • OkHttp / SSE        │
└─────────────────────────────┬─────────────────────────────┘
                              │ HTTP / SSE (localhost:8080)
                              ▼
┌───────────────────────────────────────────────────────────┐
│             Antigravity Termux Server (Node.js)           │
│  ├── /api/fs/*       (Termux Dosya Sistemi Köprüsü)       │
│  ├── /api/models     (Dinamik Model Havuzu)               │
│  ├── /api/chat & SSE (Canlı AI Akışı & Tool Cards)        │
│  └── bin/agy-web     (Tmux & Termal Süreç Yöneticisi)     │
└─────────────────────────────┬─────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────┐
│                  Termux CLI & Dosya Alanı                 │
│   ~/agy-vault  •  ~/uploads  •  ~/.gemini/antigravity-cli  │
└───────────────────────────────────────────────────────────┘
```

---

## 🌟 Temel Özellikler

1. **📁 Yerel Dosya Sistemi Köprüsü (`/api/fs/*`):**
   - Termux çalışma alanındaki (`/data/data/com.termux/files/home`) tüm dosya ve dizinleri listeleme, okuma, yazma, silme ve klasör oluşturma.
   - Android uygulamasındaki dahili dosya yöneticisiyle tam entegrasyon.
2. **🤖 Gerçek Model Listesi & Sağlayıcı (`/api/models`):**
   - Gemini 3.8 Flash (High/Medium/Low), Gemini 3.7 Flash, Gemini 3.1 Pro, Claude Sonnet 4.6 (Thinking), GPT-OSS 120B gibi gerçek modellerin canlı önbelleği ve sunumu.
3. **⚡ Canlı Akış & Oturum Yönetimi (`/api/chat`, `/api/events`):**
   - Server-Sent Events (SSE) ile token-by-token yanıt akışı, düşünme (thinking) blokları ve araç çağrısı kartları (tool call cards).
4. **🔄 Otonom CI/CD Gözlemcisi (`agy-ci-watch`):**
   - GitHub Actions iş akışlarını otomatik takip eden, hata durumunda logları ayıklayıp kendi kendini onaran (self-healing) izleme motoru.
5. **🪶 Sıfır Dış Bağımlılık (Zero-Dependency):**
   - `npm install` gerektirmez. Yalnızca Node.js standart kütüphaneleri (`http`, `https`, `crypto`, `fs`, `path`, `child_process`) ile çalışır.

---

## ❄️ Termux Performans & Termal Optimizasyon Rehberi (Avenox Doktrini)

Mobil cihazlarda uzun süreli AI ve sunucu operasyonlarında pil ömrünü korumak ve aşırı ısınmayı (thermal throttling) engellemek için şu optimizasyonlar zorunlu kılınmıştır:

### 1. Çekirdek Bağlama & Düşük Öncelik (`taskset` & `nice`)
Sunucu ve arka plan izleyicileri büyük performans çekirdeklerini (big cores) meşgul etmek yerine verimlilik çekirdeklerine (LITTLE cores: 0-5) kilitlenir:
```bash
# agy-web tarafından otomatik uygulanır:
nice -n 10 taskset -c 0-5 node server.js
```

### 2. İş Parçacığı (Thread) Sınırlandırması
Derleme, arama veya yoğun hesaplama işlemlerinde CPU'yu %100 yük altına sokmamak için maksimum 2 thread (`-j 2`) kullanılır:
```bash
make -j 2
# veya gradle/cargo işlemlerinde thread limitleri
```

### 3. Termux Arka Plan Uyku Kilidi (Wake-Lock)
Android sisteminin Termux sürecini derin uykuya almasını önlemek için:
```bash
termux-wake-lock
```
*Ayrıca Android Ayarları → Uygulamalar → Termux → Pil bölümünden **"Kısıtlanmamış" (Unrestricted)** seçilmelidir.*

### 4. Dış Uygulama İzinleri (`termux.properties`)
Android uygulamalarının localhost köprüsüne ve harici çağrılara erişebilmesi için `~/.termux/termux.properties` dosyasında şu satır bulunmalıdır:
```properties
allow-external-apps = true
```

---

## 🚀 Hızlı Kurulum

Termux terminalinizi açın ve tek komutla kurulumu tamamlayın:

```bash
git clone https://github.com/TheOsmanYILDIRIM/antigravity-termux-server.git ~/antigravity-termux-server
cd ~/antigravity-termux-server
chmod +x install.sh && ./install.sh
```

Kurulum scripti şunları otomatik olarak yapar:
- Eksik paketleri (`nodejs`, `tmux`, `jq`, `git`, `curl`) tespit edip kurar.
- `agy-web` ve `agy-ci-watch` komutlarını `$PREFIX/bin` altına bağlar.
- Gerekli çalışma klasörlerini (`uploads`, `agy-vault`, `data`) hazırlar.
- Termux özelliklerini ve wake-lock ayarlarını yapılandırır.

---

## 🎮 Kullanım & CLI Yönetimi

Sunucu `tmux` arka plan oturumunda yönetilir:

| Komut | Açıklama |
|---|---|
| `agy-web start` | Sunucuyu optimize edilmiş çekirdeklerle arka planda başlatır (`:8080`) |
| `agy-web status` | Sunucunun aktif durumunu ve PID numarasını gösterir |
| `agy-web stop` | Arka plandaki sunucuyu güvenli şekilde durdurur |
| `agy-web restart` | Sunucuyu yeniden başlatır |
| `agy-web attach` | Canlı sunucu konsol loglarına bağlanır (`Ctrl+B` ardından `D` ile çıkılır) |
| `agy-web open` | Tarayıcınızda sunucu web arayüzünü açar |

---

## 📡 API Uç Noktaları (Endpoints)

### 1. Dosya Sistemi Köprüsü (`/api/fs/*`)
| Metot | Uç Nokta | Parametre / Gövde | Açıklama |
|---|---|---|---|
| `GET` | `/api/fs/ls?path=...` | `path` (Dizin yolu) | Dizin içeriğini dosya/klasör olarak listeler |
| `GET` | `/api/fs/read?path=...` | `path` (Dosya yolu) | Dosyanın metin içeriğini döndürür |
| `POST`| `/api/fs/write` | `{ path: "...", content: "..." }` | Dosyaya içerik yazar/günceller |
| `GET` | `/api/fs/stat?path=...` | `path` (Dosya/dizin) | Boyut, değiştirilme zamanı ve izinleri döndürür |
| `POST`| `/api/fs/mkdir` | `{ path: "..." }` | Yeni dizin oluşturur |
| `POST`| `/api/fs/rm` | `{ path: "..." }` | Dosya veya dizini siler |

### 2. Model & AI Akışı
| Metot | Uç Nokta | Açıklama |
|---|---|---|
| `GET` | `/api/models` | Kullanılabilir gerçek model listesini döndürür |
| `POST`| `/api/chat` | AI sohbet isteğini başlatır |
| `GET` | `/api/events` | SSE canlı akış kanalı (tokenlar, araç çağrıları) |
| `POST`| `/api/chat/stop` | Devam eden akışı iptal eder |

---

## 🛡️ Otonom CI/CD Gözlemcisi (`agy-ci-watch`)

Sunucu paketiyle birlikte gelen `agy-ci-watch`, Android veya Web reposunda `git push` yapıldığında GitHub Actions sürecini Termux üzerinden arka planda izler:

```bash
# Manuel çalıştırma:
agy-ci-watch /path/to/repo

# Git pre-push hook ile otomatik çalıştırma:
# Reponun .git/hooks/pre-push dosyasına ekleyin:
agy-ci-watch "$PWD" >/dev/null 2>&1 &
```

- Workflow başarısız olursa derleme loglarını çeker.
- Sorunu otomatik analiz eder ve self-healing döngüsünü tetikler.
- Düşük pil tüketimi için `nice -n 15` ve `taskset -c 0-5` ile çalışır.

---

## 📱 İlgili Projeler

- **Android İstemcisi:** [TheOsmanYILDIRIM/antigravity-android](https://github.com/TheOsmanYILDIRIM/antigravity-android) — Jetpack Compose ile yazılmış native mobil istemci.

---

## 📄 Lisans

Bu proje MIT lisansı ile korunmaktadır.
