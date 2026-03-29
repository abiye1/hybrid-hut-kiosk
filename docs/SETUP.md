# Quick Setup Guide

Assumes Ubuntu 22.04+, root access, domain already pointed at server IP.

## 1. Install Dependencies

```bash
apt-get update && apt-get install -y curl gnupg ca-certificates postgresql postgresql-contrib

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs

# Caddy
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# PM2
npm install -g pm2

# PostgreSQL
systemctl enable --now postgresql
```

## 2. Clone & Install

```bash
git clone https://github.com/abiye1/hybrid-hut-kiosk.git /opt/hybrid-hut
cd /opt/hybrid-hut && npm install
cp .env.example .env && nano .env
```

## 3. Database

```bash
sudo -u postgres psql -c "CREATE USER hybridhut WITH PASSWORD 'YOUR_PASS';"
sudo -u postgres psql -c "CREATE DATABASE hybrid_hut OWNER hybridhut;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE hybrid_hut TO hybridhut;"
sudo -u postgres psql -d hybrid_hut < docs/schema.sql
sudo -u postgres psql -d hybrid_hut -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO hybridhut;"
sudo -u postgres psql -d hybrid_hut -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO hybridhut;"
```

## 4. Caddy

```bash
cat > /etc/caddy/Caddyfile <<EOF
your-domain.com {
    root * /opt/hybrid-hut/public
    file_server
    reverse_proxy /api/* localhost:3001
}
EOF
systemctl enable --now caddy
```

## 5. Start App

```bash
cd /opt/hybrid-hut
pm2 start server.js --name hybrid-hut --time
pm2 save
env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root
systemctl enable pm2-root && systemctl start pm2-root
```

## 6. Verify

```bash
curl https://your-domain/api/health        # {"status":"ok",...}
curl https://your-domain/api/products      # {"products":[...]}
curl https://your-domain/api/memberships   # {"memberships":[...]}
```

## Useful Commands

```bash
pm2 logs hybrid-hut          # Live logs
pm2 restart hybrid-hut       # Restart backend
systemctl reload caddy        # Reload Caddy config
sudo -u postgres psql -d hybrid_hut   # DB shell
```
