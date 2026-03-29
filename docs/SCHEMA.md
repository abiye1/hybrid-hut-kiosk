# Database Schema

PostgreSQL 16 — database: `hybrid_hut`, user: `hybridhut`

## Tables

### `memberships`

Stores gym membership plans shown on the kiosk.

```sql
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
```

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| id | SERIAL | NO | Auto-increment primary key |
| name | VARCHAR(255) | NO | Display name of the plan |
| price_pence | INTEGER | NO | Price in pence (£1.00 = 100) |
| period | VARCHAR(50) | YES | Display period e.g. "per month", "one-off" |
| type | VARCHAR(20) | NO | `recurring` / `punchcard` / `oneoff` |
| active | BOOLEAN | NO | `false` = soft deleted, hidden from kiosk |
| created_at | TIMESTAMPTZ | NO | Row creation time |
| updated_at | TIMESTAMPTZ | NO | Last modification time |

**Seed data:**
```sql
INSERT INTO memberships (name, price_pence, period, type) VALUES
  ('Chapo''s Angels Ladies Only Group Training',         5500, 'per month', 'recurring'),
  ('Chapo''s Angels Ladies Only Group Training + Gym',   6500, 'per month', 'recurring'),
  ('Gym Class',                                           800, 'punchcard', 'punchcard'),
  ('Gym Day Pass',                                        800, 'one-off',   'oneoff'),
  ('Gym Membership',                                     4000, 'per month', 'recurring');
```

---

### `products`

Stores retail products (drinks, supplements, snacks) sold at the kiosk.

```sql
CREATE TABLE products (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(255)  NOT NULL,
  price_pence INTEGER       NOT NULL,
  category    VARCHAR(100)  NOT NULL DEFAULT 'product',
  active      BOOLEAN       NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| id | SERIAL | NO | Auto-increment primary key |
| name | VARCHAR(255) | NO | Product display name |
| price_pence | INTEGER | NO | Price in pence |
| category | VARCHAR(100) | NO | Category tag e.g. "product", "supplement", "drink" |
| active | BOOLEAN | NO | `false` = soft deleted, hidden from kiosk |
| created_at | TIMESTAMPTZ | NO | Row creation time |
| updated_at | TIMESTAMPTZ | NO | Last modification time |

**Seed data:**
```sql
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
```

---

## Useful Queries

```sql
-- All active products ordered by name
SELECT * FROM products WHERE active = true ORDER BY name;

-- All memberships including inactive
SELECT * FROM memberships ORDER BY price_pence;

-- Soft delete a product
UPDATE products SET active = false, updated_at = NOW() WHERE id = 3;

-- Restore a product
UPDATE products SET active = true, updated_at = NOW() WHERE id = 3;

-- Update a price
UPDATE products SET price_pence = 250, updated_at = NOW() WHERE name = 'WATER';
```

---

## Notes

- All prices are stored as **integers in pence** — never as decimals
- Deletes are always **soft** (set `active = false`) — no hard deletes
- `updated_at` is set manually on every UPDATE — no trigger (future improvement)
- Transaction history is **not stored** in PostgreSQL — it comes live from Stripe API
