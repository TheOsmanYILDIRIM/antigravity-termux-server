#!/data/data/com.termux/files/usr/bin/bash
# ==============================================================================
# Antigravity Termux Server & Filesystem Bridge - Kurulum & Optimizasyon Scripti
# ==============================================================================

set -e

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="$PREFIX/bin"

echo "=================================================="
echo "⚡ Antigravity Termux Server Kurulumu Başlatılıyor"
echo "📂 Konum: $REPO_DIR"
echo "=================================================="

# 1. Gerekli paketlerin kontrolü ve kurulumu
echo "📦 Gerekli komutlar kontrol ediliyor..."
MISSING_PKGS=""

command -v node >/dev/null 2>&1 || MISSING_PKGS="$MISSING_PKGS nodejs"
command -v tmux >/dev/null 2>&1 || MISSING_PKGS="$MISSING_PKGS tmux"
command -v jq >/dev/null 2>&1 || MISSING_PKGS="$MISSING_PKGS jq"
command -v git >/dev/null 2>&1 || MISSING_PKGS="$MISSING_PKGS git"
command -v curl >/dev/null 2>&1 || MISSING_PKGS="$MISSING_PKGS curl"

if [ -n "$MISSING_PKGS" ]; then
    echo "⬇️ Eksik paketler kuruluyor:$MISSING_PKGS"
    pkg update -y && pkg install -y $MISSING_PKGS
else
    echo "✅ Tüm gerekli araçlar kurulu (Node.js, tmux, jq, git, curl)."
fi

# 2. İzinler ve Symlink'ler
echo "🔗 CLI kısayolları ($BIN_DIR) yapılandırılıyor..."
chmod +x "$REPO_DIR/bin/agy-web"
chmod +x "$REPO_DIR/bin/agy-ci-watch"

ln -sf "$REPO_DIR/bin/agy-web" "$BIN_DIR/agy-web"
ln -sf "$REPO_DIR/bin/agy-ci-watch" "$BIN_DIR/agy-ci-watch"

# 3. Gerekli dizin yapısını hazırlama
echo "📁 Çalışma dizinleri hazırlanıyor..."
mkdir -p "$REPO_DIR/data/sessions"
mkdir -p "$HOME/uploads"
mkdir -p "$HOME/agy-vault"

# 4. Termux Optimizasyonları
echo "⚡ Termux optimizasyonları kontrol ediliyor..."

# ~/.termux/termux.properties ayarları
TERMUX_PROP="$HOME/.termux/termux.properties"
mkdir -p "$HOME/.termux"
if [ ! -f "$TERMUX_PROP" ]; then
    touch "$TERMUX_PROP"
fi

if ! grep -q "^allow-external-apps" "$TERMUX_PROP"; then
    echo "allow-external-apps = true" >> "$TERMUX_PROP"
    echo "  • [termux.properties] allow-external-apps = true eklendi."
fi

# Wake Lock kontrolü
if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock 2>/dev/null || true
    echo "  • [WakeLock] Termux arka plan uyku kilidi (wake-lock) aktifleştirildi."
fi

echo "=================================================="
echo "🎉 Kurulum Başarıyla Tamamlandı!"
echo "=================================================="
echo "📌 Kullanım Komutları:"
echo "   agy-web start    -> Sunucuyu tmux arka planında başlatır (Port: 8080)"
echo "   agy-web status   -> Sunucu durumunu ve PID kontrol eder"
echo "   agy-web stop     -> Sunucuyu durdurur"
echo "   agy-web attach   -> Canlı log ekranına bağlanır"
echo "   agy-ci-watch     -> GitHub Actions CI/CD izleyici & otomatik onarım"
echo ""
echo "📱 Antigravity AI Android Uygulaması ile Bağlantı:"
echo "   Android uygulamasında sol çekmeceden 'Termux Dosyaları'na"
echo "   tıklayarak Termux dosya sisteminize erişebilirsiniz."
echo "=================================================="
