# Hybrid Hut — Membership & POS Kiosk

A kiosk-style web application for **Hybrid Hut Rochdale** gym. Members can select a membership plan or purchase products, and pay via a Stripe WisePOS E card reader. Staff manage products, memberships, and view transaction reports via a PIN-gated admin panel.

Live at: **https://membership.hybridhut.co.uk**

---

## Architecture

```
┌─────────────────┐   HTTPS/80   ┌──────────────────┐   Stripe API   ┌──────────────┐
│   Browser        │ ──────────── │  Caddy (reverse   │ ────────────── │  Stripe      │
│   (Kiosk UI)     │              │  proxy + TLS)     │                │  WisePOS E   │
└─────────────────┘              └────────┬─────────┘                └──────────────┘
                                          │ :3001
                                 ┌────────▼─────────┐   SQL   ┌──────────────┐
                                 │  Node.js/Express  │ ─────── │  PostgreSQL  │
                                 │  (PM2 managed)    │         │  16          │
                                 └──────────────────┘         └──────────────┘
```

**Request flow:**
1. Caddy receives HTTPS request, terminates TLS
2. Static files (`/`) served directly from `/opt/hybrid-hut/public/`
3. API requests (`/api/*`) reverse-proxied to Node.js on port 3001
4. Node.js reads products/memberships from PostgreSQL
5. Payment requests forwarded to Stripe Terminal API
6. WisePOS E reader processes the physical card
7. Backend polls Stripe until payment succeeds or fails

---

## Tech Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Web server | Caddy | 2.11.2 |
| Backend | Node.js + Express | 20.20.0 |
| Package manager | npm | 10.8.2 |
| Database | PostgreSQL | 16.13 |
| Process manager | PM2 | 6.0.14 |
| Payments | Stripe Terminal SDK | 17.x |
| Frontend | Vanilla JS (single HTML file) | — |
| OS | Ubuntu 22.04+ | — |

---

## Features (Implemented)

### Kiosk UI
- Two-tab layout: **Memberships** and **Products & Items**
- Membership tab: select a plan, shows badge (Recurring/Punchcard/One-off), price, period
- Products tab: cart-style with +/− quantity controls per item, live subtotal
- Custom amount card (PIN-gated with code `2200`)
- Full payment flow: create PaymentIntent → send to WisePOS E → poll for result → show success/fail
- Auto-reset after successful payment (5 seconds)

### Admin Panel
Access via ⚙ icon (bottom-right) → PIN `2200`
- **Products**: add, edit, soft-delete products (name, price in £)
- **Memberships**: add, edit, soft-delete membership plans (name, price, period, type)
- **Transactions**: full transaction list with date/time, description, amount, status badge
- **Daily Totals**: revenue grouped by day with grand total

### Infrastructure
- HTTPS with automatic Let's Encrypt certificate (Caddy)
- PM2 auto-restarts on crash, auto-starts on server reboot
- PostgreSQL persists products and memberships
- Timestamps on all PM2 logs

---

## Planned Features (Roadmap)

### Phase 1 — High Impact
- Recurring subscriptions (save card → Stripe Subscription)
- Stock/inventory tracking with low-stock alerts
- Refunds from admin panel
- End-of-day reports
- Member lookup at point of sale

### Phase 2 — Medium Priority
- Discount codes and vouchers
- Email/SMS receipts via Stripe or Twilio
- Loyalty/rewards points system
- CSV export of transactions
- Revenue analytics by product/category
- Tipping prompt at checkout
- Split payments across multiple cards
- Cash payment tracking

### Phase 3 — Long Term
- Xero/QuickBooks accounting integration
- Offline mode with local queue
- Multi-location support
- Digital membership cards with QR check-in
- Stripe webhook integration (replace polling)
- Role-based staff logins
- Membership expiry tracking and renewal reminders
- Dunning management for failed subscription payments
- Google Sheets live sync
- Barcode/QR scanner support

---

## Server Requirements

- Ubuntu 22.04 LTS or later
- 1 vCPU, 1GB RAM minimum (2GB recommended)
- Ports **80** and **443** open inbound
- A domain name pointed at the server's public IP

---

## Full Setup Guide (New Server)

### 1. Install System Dependencies

```bash
apt-get update && apt-get install -y curl gnupg ca-certificates

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Caddy
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

# PM2
npm install -g pm2

# PostgreSQL
apt-get install -y postgresql postgresql-contrib
systemctl enable --now postgresql
```

### 2. Clone Repository

```bash
git clone https://github.com/abiye1/hybrid-hut-kiosk.git /opt/hybrid-hut
cd /opt/hybrid-hut
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
nano .env
# Fill in: STRIPE_SECRET_KEY, STRIPE_TERMINAL_READER_ID, DB_PASSWORD
```

### 4. Set Up PostgreSQL

```bash
sudo -u postgres psql -c "CREATE USER hybridhut WITH PASSWORD 'YOUR_PASSWORD';"
sudo -u postgres psql -c "CREATE DATABASE hybrid_hut OWNER hybridhut;"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE hybrid_hut TO hybridhut;"

sudo -u postgres psql -d hybrid_hut <<'SQL'
CREATE TABLE memberships (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255) NOT NULL,
  price_pence INTEGER      NOT NULL,
  period      VARCHAR(50),
  type        VARCHAR(20)  NOT NULL DEFAULT 'recurring',
  active      BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE products (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255)  NOT NULL,
  price_pence INTEGER       NOT NULL,
  category    VARCHAR(100)  NOT NULL DEFAULT 'product',
  active      BOOLEAN       NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO memberships (name, price_pence, period, type) VALUES
  ('Chapo''s Angels Ladies Only Group Training',         5500, 'per month',  'recurring'),
  ('Chapo''s Angels Ladies Only Group Training + Gym',   6500, 'per month',  'recurring'),
  ('Gym Class',                                           800, 'punchcard',  'punchcard'),
  ('Gym Day Pass',                                        800, 'one-off',    'oneoff'),
  ('Gym Membership',                                     4000, 'per month',  'recurring');

INSERT INTO products (name, price_pence, category) VALUES
  ('Actiph Electrolyte water',  200, 'product'),
  ('Lucozade sport',            170, 'product'),
  ('Red-bull sugar free',       160, 'product'),
  ('WATER',                     100, 'product'),
  ('1 scoop creatine',          150, 'product'),
  ('Grenade protein bars',      300, 'product'),
  ('Optimum nutrition Bar',     300, 'product'),
  ('Grenade protein shake',     300, 'product'),
  ('Optimum nutrition shake',   300, 'product'),
  ('1 scoop pre-workout',       200, 'product');
SQL

sudo -u postgres psql -d hybrid_hut -c "GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO hybridhut;"
sudo -u postgres psql -d hybrid_hut -c "GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO hybridhut;"
```

### 5. Configure Caddy

```bash
cat > /etc/caddy/Caddyfile <<'EOF'
your-domain.com {
    root * /opt/hybrid-hut/public
    file_server
    reverse_proxy /api/* localhost:3001
}
EOF
```

Replace `your-domain.com` with your actual domain (e.g. `membership.hybridhut.co.uk`).

### 6. Register WisePOS E Reader

1. Go to [Stripe Dashboard → Terminal → Readers](https://dashboard.stripe.com/terminal/readers)
2. Click **+ Add Reader** and enter the registration code shown on the device
3. Note the **Reader ID** (starts with `tmr_`) — add to `.env`

### 7. Start the Application

```bash
cd /opt/hybrid-hut
pm2 start server.js --name hybrid-hut --time
pm2 save
env PATH=$PATH:/usr/bin pm2 startup systemd -u root --hp /root
systemctl enable pm2-root
systemctl start pm2-root
systemctl enable --now caddy
```

### 8. Verify

```bash
curl https://your-domain/api/health
curl https://your-domain/api/products
curl https://your-domain/api/memberships
```

---

## API Reference

See [`docs/API.md`](docs/API.md) for full request/response documentation.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | None | Health check |
| POST | `/api/connection-token` | None | Stripe Terminal connection token |
| POST | `/api/create-payment-intent` | None | Create a PaymentIntent |
| POST | `/api/process-terminal-payment` | None | Send PaymentIntent to reader |
| POST | `/api/cancel-reader-action` | None | Cancel pending reader action |
| GET | `/api/readers` | None | List registered Terminal readers |
| GET | `/api/products` | None | List active products |
| GET | `/api/memberships` | None | List active memberships |
| POST | `/api/admin/verify` | None | Verify admin PIN |
| GET | `/api/admin/products` | PIN | All products (inc. inactive) |
| POST | `/api/admin/products` | PIN | Create product |
| PUT | `/api/admin/products/:id` | PIN | Update product |
| DELETE | `/api/admin/products/:id` | PIN | Soft-delete product |
| GET | `/api/admin/memberships` | PIN | All memberships |
| POST | `/api/admin/memberships` | PIN | Create membership |
| PUT | `/api/admin/memberships/:id` | PIN | Update membership |
| DELETE | `/api/admin/memberships/:id` | PIN | Soft-delete membership |
| GET | `/api/admin/transactions` | PIN | Recent PaymentIntents from Stripe |
| GET | `/api/admin/transactions/daily` | PIN | Succeeded payments grouped by day |

---

## Database Schema

See [`docs/SCHEMA.md`](docs/SCHEMA.md) for full schema documentation.

### memberships
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | SERIAL | auto | Primary key |
| name | VARCHAR(255) | — | Plan name |
| price_pence | INTEGER | — | Price in pence (£1.00 = 100) |
| period | VARCHAR(50) | NULL | Display period e.g. "per month" |
| type | VARCHAR(20) | recurring | recurring / punchcard / oneoff |
| active | BOOLEAN | true | False = soft deleted |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

### products
| Column | Type | Default | Description |
|--------|------|---------|-------------|
| id | SERIAL | auto | Primary key |
| name | VARCHAR(255) | — | Product name |
| price_pence | INTEGER | — | Price in pence |
| category | VARCHAR(100) | product | Product category |
| active | BOOLEAN | true | False = soft deleted |
| created_at | TIMESTAMPTZ | NOW() | Creation timestamp |
| updated_at | TIMESTAMPTZ | NOW() | Last update timestamp |

---

## File Structure

```
/opt/hybrid-hut/
├── server.js           # Express backend — all API routes
├── package.json        # Dependencies: express, stripe, pg, cors, dotenv
├── .env                # Secrets — NOT in git
├── .env.example        # Template for .env
├── .gitignore
├── README.md
├── docs/
│   ├── API.md          # Full API reference with examples
│   ├── SETUP.md        # Quick-start for experienced devs
│   ├── SCHEMA.md       # Database schema documentation
│   └── ROADMAP.md      # Feature roadmap by phase
└── public/
    └── index.html      # Complete frontend SPA (vanilla JS)

/etc/caddy/Caddyfile    # Web server + reverse proxy config
```

---

## Admin Panel

- **Access**: Click the ⚙ icon in the bottom-right corner of the kiosk
- **PIN**: `2200`
- **Tabs**: Products | Memberships | Transactions
- **Products**: Add/edit/delete items sold at the gym
- **Memberships**: Add/edit/delete membership plans
- **Transactions**: Full list of Stripe PaymentIntents with status; daily revenue totals

> ⚠️ Change the admin PIN before deploying to production. It is currently hardcoded as `2200` in both `server.js` and `public/index.html`.

---

## Deployment Notes

- `.env` is gitignored — **never commit real Stripe keys**
- PM2 auto-restarts the app on crash and on server reboot
- Caddy auto-renews SSL certificates via Let's Encrypt (no action needed)
- All prices stored in **pence** (integer) — divide by 100 for display
- Soft deletes only — setting `active = false` hides items without data loss
- Transaction history comes from Stripe API (last 100) — not stored locally

---

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| Payment shows "requires_payment_method" | Polling catches PI before reader processes card | Fixed — poll now only treats `requires_payment_method` as failure after seeing `processing` state |
| Reader ID invalid error | ID starts with `thor_` not `tmr_` | Get correct ID from Stripe Dashboard → Terminal → Readers |
| Products/memberships not loading | Frontend expected array, API returns `{products:[...]}` | Fixed — frontend unwraps `.products` / `.memberships` key |
| Prices showing £NaN | Frontend used `m.price` but DB field is `price_pence` | Fixed — all references use `price_pence` |
| Admin table empty | Admin load stored full object not array | Fixed — unwraps `.products` / `.memberships` from admin API response |
| Terminal reader offline | Reader not connected to same network or powered off | Check device is on and connected to wifi |

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit changes: `git commit -m 'Add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request

See open issues for planned features: https://github.com/abiye1/hybrid-hut-kiosk/issues
