# APK Patch Suite v3.1

<p align="center">
  <img src="https://img.shields.io/badge/version-3.1.0-blue?style=flat-square"/>
  <img src="https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square"/>
  <img src="https://img.shields.io/badge/platform-Ubuntu%2024-orange?style=flat-square"/>
  <img src="https://img.shields.io/badge/license-MIT-lightgrey?style=flat-square"/>
</p>

> Web-based tool untuk **Flutter SSL Bypass** dan **APK Patching** dengan antarmuka real-time live log. Mendukung berbagai patch: SSL bypass, Pairip, screenshot bypass, dan banyak lagi.

---

## ✨ Fitur

- 🔐 **Flutter SSL Patch** — Bypass SSL certificate verification pada libflutter.so
- 📦 **APK Patcher** — 11 opsi patch via Apktool + smali
- 📡 **Real-time Live Log** — SSE streaming log proses langsung ke browser
- 📱 **Responsive UI** — Mendukung desktop, tablet, dan mobile
- ⚡ **Auto Cleanup** — File upload/output dihapus otomatis setelah expire

---

## 🚀 Auto Install — VPS Ubuntu 24 (Fresh)

> **Jalankan satu perintah berikut sebagai root atau user dengan sudo:**

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/pt-zenity/Webpatcher/main/install.sh)
```

Atau jika ingin download dulu lalu jalankan:

```bash
curl -fsSL https://raw.githubusercontent.com/pt-zenity/Webpatcher/main/install.sh -o install.sh
chmod +x install.sh
bash install.sh
```

---

## 📋 Instalasi Manual — Step by Step

### 1. Update sistem & install dependensi dasar

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git wget unzip software-properties-common ca-certificates gnupg lsb-release
```

### 2. Install Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # harus v20.x.x
npm -v
```

### 3. Install Java 21

```bash
sudo apt install -y openjdk-21-jdk
java -version   # harus openjdk 21
```

### 4. Install Python 3 & pip

```bash
sudo apt install -y python3 python3-pip python3-venv
python3 --version   # harus 3.12+
```

### 5. Install Apktool 2.10

```bash
sudo apt install -y aapt zipalign apksigner

# Download Apktool wrapper
sudo wget -q https://raw.githubusercontent.com/iBotPeaches/Apktool/master/scripts/linux/apktool \
  -O /usr/local/bin/apktool
sudo chmod +x /usr/local/bin/apktool

# Download Apktool JAR
sudo wget -q https://github.com/iBotPeaches/Apktool/releases/download/v2.10.0/apktool_2.10.0.jar \
  -O /usr/local/lib/apktool.jar

apktool --version   # harus 2.10.0
```

### 6. Install PM2 (Process Manager)

```bash
sudo npm install -g pm2
pm2 -v
```

### 7. Clone repository

```bash
cd /opt
sudo git clone https://github.com/pt-zenity/Webpatcher.git apkpatcher
sudo chown -R $USER:$USER /opt/apkpatcher
cd /opt/apkpatcher
```

### 8. Install Node dependencies

```bash
npm install --production
```

### 9. Buat direktori yang diperlukan

```bash
mkdir -p uploads outputs logs
```

### 10. Jalankan dengan PM2

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # ikuti instruksi yang muncul
```

### 11. Verifikasi

```bash
pm2 list
curl http://localhost:3000/api/health
```

---

## 🔥 Install Script Otomatis (`install.sh`)

Script ini dibuat otomatis saat README dibuat. Lihat file [`install.sh`](./install.sh) di root repo.

---

## ⚙️ Konfigurasi

### Port default: `3000`

Ubah port di `server.js` baris pertama:
```js
const PORT = 3000; // ganti sesuai kebutuhan
```

### Batas ukuran file

| Tipe File | Batas |
|-----------|-------|
| `.so` / `.bin` | 150 MB |
| `.apk` | 500 MB |

### Waktu expire file

| Tipe | Waktu |
|------|-------|
| Binary upload | 20 menit |
| APK upload | 60 menit |
| APK output | 30 menit |

---

## 🌐 Setup Domain + Nginx Reverse Proxy (Opsional)

### Install Nginx

```bash
sudo apt install -y nginx
```

### Konfigurasi virtual host

```bash
sudo nano /etc/nginx/sites-available/apkpatcher
```

Isi dengan:

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    client_max_body_size 512M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_cache_bypass $http_upgrade;

        # SSE support (real-time log)
        proxy_buffering off;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/apkpatcher /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

### SSL dengan Certbot (HTTPS)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

## 🔒 Setup Firewall (UFW)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3000/tcp   # hapus setelah pakai Nginx
sudo ufw enable
sudo ufw status
```

---

## 🛠️ Perintah PM2 Berguna

```bash
pm2 list                          # lihat semua proses
pm2 logs flutter-ssl-patch        # lihat log live
pm2 logs flutter-ssl-patch --nostream  # lihat log tanpa blocking
pm2 restart flutter-ssl-patch     # restart app
pm2 stop flutter-ssl-patch        # stop app
pm2 delete flutter-ssl-patch      # hapus dari PM2
pm2 monit                         # monitor real-time CPU/RAM
```

---

## 📡 API Endpoints

| Method | Endpoint | Deskripsi |
|--------|----------|-----------|
| `GET` | `/api/health` | Status server & tools |
| `POST` | `/api/patch` | Flutter SSL patch (libflutter.so) |
| `POST` | `/api/detect` | Deteksi arsitektur binary |
| `GET` | `/api/download/:id` | Download file hasil patch |
| `POST` | `/api/apk/scan` | Scan info APK |
| `POST` | `/api/apk/patch` | Mulai job patch APK (async) |
| `GET` | `/api/apk/status/:jobId` | SSE stream log patch APK |

---

## 🐛 Troubleshooting

### Port 3000 sudah dipakai
```bash
fuser -k 3000/tcp
pm2 restart flutter-ssl-patch
```

### Apktool tidak ditemukan
```bash
which apktool
apktool --version
# Jika error, install ulang step 5
```

### Java tidak ditemukan
```bash
java -version
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
echo 'export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64' >> ~/.bashrc
source ~/.bashrc
```

### Node modules error
```bash
cd /opt/apkpatcher
rm -rf node_modules package-lock.json
npm install --production
pm2 restart flutter-ssl-patch
```

### Cek log error
```bash
pm2 logs flutter-ssl-patch --nostream --lines 50
cat /opt/apkpatcher/logs/err.log
```

---

## 📁 Struktur Project

```
apkpatcher/
├── server.js           # Express server utama
├── patcher.js          # Logic Flutter SSL patch
├── apk_patcher.js      # Wrapper APK patcher (subprocess Python)
├── ecosystem.config.cjs # Konfigurasi PM2
├── package.json
├── public/
│   └── index.html      # UI web (single file)
├── uploads/            # File upload sementara (auto cleanup)
├── outputs/            # File hasil patch (auto cleanup)
└── logs/               # PM2 log files
```

---

## 📜 Tech Stack

| Komponen | Versi |
|----------|-------|
| Node.js | v20 LTS |
| Express | v5 |
| Java | 21 (OpenJDK) |
| Apktool | 2.10.0 |
| Python | 3.12 |
| PM2 | latest |

---

## 🤝 Credits

- [iBotPeaches/Apktool](https://github.com/iBotPeaches/Apktool)
- [AbhiTheModder/termux-scripts](https://github.com/AbhiTheModder/termux-scripts)

---

<p align="center">Made with ❤️ — APK Patch Suite v3.1.0</p>
