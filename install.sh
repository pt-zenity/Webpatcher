#!/usr/bin/env bash
# =============================================================================
#  APK Patch Suite v3.1 — Auto Installer for Ubuntu 24 LTS
#  Repo : https://github.com/pt-zenity/Webpatcher
#  Usage: bash <(curl -fsSL https://raw.githubusercontent.com/pt-zenity/Webpatcher/main/install.sh)
# =============================================================================

set -euo pipefail

# ── Warna ────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✅  $*${NC}"; }
info() { echo -e "${CYAN}ℹ️   $*${NC}"; }
warn() { echo -e "${YELLOW}⚠️   $*${NC}"; }
fail() { echo -e "${RED}❌  $*${NC}"; exit 1; }
step() { echo -e "\n${BOLD}${BLUE}▶ $*${NC}"; }

# ── Banner ───────────────────────────────────────────────────────────────────
clear
echo -e "${BOLD}${CYAN}"
cat << 'EOF'
  █████╗ ██████╗ ██╗  ██╗    ██████╗  █████╗ ████████╗ ██████╗██╗  ██╗
 ██╔══██╗██╔══██╗██║ ██╔╝    ██╔══██╗██╔══██╗╚══██╔══╝██╔════╝██║  ██║
 ███████║██████╔╝█████╔╝     ██████╔╝███████║   ██║   ██║     ███████║
 ██╔══██║██╔═══╝ ██╔═██╗     ██╔═══╝ ██╔══██║   ██║   ██║     ██╔══██║
 ██║  ██║██║     ██║  ██╗    ██║     ██║  ██║   ██║   ╚██████╗██║  ██║
 ╚═╝  ╚═╝╚═╝     ╚═╝  ╚═╝    ╚═╝     ╚═╝  ╚═╝   ╚═╝    ╚═════╝╚═╝  ╚═╝
              APK Patch Suite v3.1 — Auto Installer
EOF
echo -e "${NC}"
echo -e "  ${BOLD}Target OS : Ubuntu 24 LTS${NC}"
echo -e "  ${BOLD}Repo      : https://github.com/pt-zenity/Webpatcher${NC}"
echo -e "  ${BOLD}Port      : 3000${NC}"
echo ""

# ── Cek OS ───────────────────────────────────────────────────────────────────
step "Memeriksa sistem operasi..."
if [[ ! -f /etc/os-release ]]; then
  fail "Tidak dapat mendeteksi OS. Script ini hanya untuk Ubuntu 24."
fi
source /etc/os-release
if [[ "$ID" != "ubuntu" ]]; then
  fail "OS bukan Ubuntu (terdeteksi: $ID). Script ini hanya untuk Ubuntu."
fi
info "OS terdeteksi: $PRETTY_NAME"

# ── Cek root / sudo ───────────────────────────────────────────────────────────
step "Memeriksa hak akses..."
if [[ $EUID -ne 0 ]]; then
  SUDO="sudo"
  warn "Bukan root — menggunakan sudo"
else
  SUDO=""
  info "Berjalan sebagai root"
fi

# ── Variabel instalasi ────────────────────────────────────────────────────────
INSTALL_DIR="/opt/apkpatcher"
APP_USER="${SUDO_USER:-$USER}"
APKTOOL_VERSION="2.10.0"
APKTOOL_JAR="apktool_${APKTOOL_VERSION}.jar"
NODE_MAJOR=20

# ── 1. Update sistem ──────────────────────────────────────────────────────────
step "1/9  Update & upgrade sistem..."
$SUDO apt-get update -qq
$SUDO apt-get upgrade -y -qq
$SUDO apt-get install -y -qq \
  curl git wget unzip zip \
  software-properties-common ca-certificates gnupg lsb-release \
  build-essential
ok "Sistem diperbarui"

# ── 2. Node.js 20 ─────────────────────────────────────────────────────────────
step "2/9  Install Node.js ${NODE_MAJOR} LTS..."
if command -v node &>/dev/null && [[ "$(node -e 'process.stdout.write(process.version.split(\".\")[0].slice(1))')" -ge "$NODE_MAJOR" ]]; then
  ok "Node.js sudah terinstall: $(node -v)"
else
  curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | $SUDO -E bash - -qq
  $SUDO apt-get install -y -qq nodejs
  ok "Node.js terinstall: $(node -v)"
fi

# ── 3. Java 21 ────────────────────────────────────────────────────────────────
step "3/9  Install Java 21 (OpenJDK)..."
if java -version &>/dev/null 2>&1; then
  ok "Java sudah terinstall: $(java -version 2>&1 | head -1)"
else
  $SUDO apt-get install -y -qq openjdk-21-jdk
  ok "Java terinstall: $(java -version 2>&1 | head -1)"
fi

# Set JAVA_HOME
JAVA_HOME_PATH=$(dirname $(dirname $(readlink -f $(which java))))
if ! grep -q "JAVA_HOME" /etc/environment 2>/dev/null; then
  echo "JAVA_HOME=${JAVA_HOME_PATH}" | $SUDO tee -a /etc/environment > /dev/null
  export JAVA_HOME="${JAVA_HOME_PATH}"
fi

# ── 4. Python 3 ───────────────────────────────────────────────────────────────
step "4/9  Install Python 3..."
$SUDO apt-get install -y -qq python3 python3-pip python3-venv
ok "Python terinstall: $(python3 --version)"

# ── 5. Apktool + aapt + apksigner ─────────────────────────────────────────────
step "5/9  Install Apktool ${APKTOOL_VERSION}..."
$SUDO apt-get install -y -qq aapt zipalign apksigner

# Download apktool wrapper script
$SUDO wget -q \
  "https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool" \
  -O /usr/local/bin/apktool
$SUDO chmod +x /usr/local/bin/apktool

# Download apktool JAR
$SUDO wget -q \
  "https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/${APKTOOL_JAR}" \
  -O /usr/local/lib/apktool.jar

# Verifikasi
if apktool --version &>/dev/null 2>&1; then
  ok "Apktool terinstall: $(apktool --version 2>/dev/null | head -1)"
else
  warn "Apktool terpasang tapi verifikasi gagal — cek manual dengan: apktool --version"
fi

# ── 6. PM2 ────────────────────────────────────────────────────────────────────
step "6/9  Install PM2..."
if command -v pm2 &>/dev/null; then
  ok "PM2 sudah terinstall: $(pm2 -v)"
else
  $SUDO npm install -g pm2 -q
  ok "PM2 terinstall: $(pm2 -v)"
fi

# ── 7. Clone / Update repository ──────────────────────────────────────────────
step "7/9  Clone repository..."
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Repository sudah ada di $INSTALL_DIR — melakukan git pull..."
  cd "$INSTALL_DIR"
  git pull origin main
  ok "Repository diperbarui"
else
  $SUDO mkdir -p "$INSTALL_DIR"
  $SUDO chown -R "${APP_USER}:${APP_USER}" "$INSTALL_DIR"
  git clone https://github.com/pt-zenity/Webpatcher.git "$INSTALL_DIR"
  ok "Repository di-clone ke $INSTALL_DIR"
fi

# ── 8. Install Node dependencies ──────────────────────────────────────────────
step "8/9  Install Node.js dependencies..."
cd "$INSTALL_DIR"
$SUDO chown -R "${APP_USER}:${APP_USER}" "$INSTALL_DIR"
npm install --production --silent
mkdir -p uploads outputs logs
ok "Dependencies terinstall"

# ── 9. Setup PM2 & autostart ──────────────────────────────────────────────────
step "9/9  Setup PM2 & autostart..."

# Stop proses lama jika ada
pm2 delete flutter-ssl-patch 2>/dev/null || true

# Start dengan ecosystem
pm2 start "$INSTALL_DIR/ecosystem.config.cjs"
pm2 save --force

# Setup startup (systemd)
PM2_STARTUP=$(pm2 startup systemd -u "${APP_USER}" --hp "/home/${APP_USER}" 2>&1 | grep "sudo" || true)
if [[ -n "$PM2_STARTUP" ]]; then
  eval "$SUDO $PM2_STARTUP" 2>/dev/null || warn "Autostart systemd perlu dikonfigurasi manual"
fi

pm2 save --force
ok "PM2 running & autostart dikonfigurasi"

# ── Verifikasi akhir ──────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${BOLD}${GREEN}   ✅  INSTALASI SELESAI!${NC}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""

sleep 3
HEALTH=$(curl -s http://localhost:3000/api/health 2>/dev/null || echo "{}")
echo -e "  ${BOLD}Status Health :${NC} $HEALTH"
echo ""
echo -e "  ${BOLD}📂 Install Dir :${NC} $INSTALL_DIR"
echo -e "  ${BOLD}🌐 URL Lokal   :${NC} http://localhost:3000"
echo -e "  ${BOLD}🌐 URL Publik  :${NC} http://$(curl -s ifconfig.me 2>/dev/null || echo 'YOUR_IP'):3000"
echo ""
echo -e "  ${BOLD}Perintah berguna:${NC}"
echo -e "  ${CYAN}pm2 list${NC}                          → lihat status proses"
echo -e "  ${CYAN}pm2 logs flutter-ssl-patch${NC}        → lihat log live"
echo -e "  ${CYAN}pm2 restart flutter-ssl-patch${NC}     → restart app"
echo -e "  ${CYAN}curl http://localhost:3000/api/health${NC} → cek health"
echo ""
echo -e "  ${YELLOW}⚠️  Untuk akses publik, buka port 3000:${NC}"
echo -e "  ${CYAN}sudo ufw allow 3000/tcp && sudo ufw reload${NC}"
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════${NC}"
