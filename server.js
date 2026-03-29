// ============================================================
// Hybrid Hut — Stripe Terminal Backend Server
// ============================================================
// This Express server handles:
//   1. Creating PaymentIntents
//   2. Creating Terminal ConnectionTokens
//   3. Processing payments on a WisePOS E reader
//
// SETUP:
//   1. npm install
//   2. Copy .env.example to .env and fill in your Stripe keys
//   3. Register your WisePOS E reader in Stripe Dashboard
//      (Dashboard → Terminal → Readers → Add Reader)
//   4. Update STRIPE_TERMINAL_READER_ID in .env
//   5. npm start
// ============================================================

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================
// STRIPE INIT
// ============================================================
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ============================================================
// DB POOL
// ============================================================
const { Pool } = require('pg');
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'hybrid_hut',
  user: process.env.DB_USER || 'hybridhut',
  password: process.env.DB_PASSWORD || 'hybridhut2200',
});

const rateLimit = require('express-rate-limit');

// General API limiter
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
// Strict limiter for payment endpoints
const paymentLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

app.use('/api/', apiLimiter);

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
}));
app.use(express.json());

// ============================================================
// ADMIN AUTH MIDDLEWARE
// ============================================================
function requireAdmin(req, res, next) {
  const pin = req.headers['x-admin-pin'];
  if (String(pin) === String(process.env.ADMIN_PIN || '2200')) return next();
  res.status(401).json({ error: 'Unauthorised' });
}

// ============================================================
// ROUTES
// ============================================================

/**
 * Health check
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Create a Stripe Terminal ConnectionToken
 * Used by the Stripe Terminal JS SDK to authenticate with readers.
 */
app.post('/api/connection-token', async (req, res) => {
  try {
    const connectionToken = await stripe.terminal.connectionTokens.create();
    res.json({ secret: connectionToken.secret });
  } catch (err) {
    console.error('Connection token error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Create a PaymentIntent
 * Called when the user selects a membership and clicks Pay.
 */
app.post('/api/create-payment-intent', paymentLimiter, async (req, res) => {
  try {
    const { amount, currency = 'gbp', description } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Invalid amount. Minimum is 100 (£1.00).' });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency,
      description,
      payment_method_types: ['card_present'],
      capture_method: 'automatic',
      metadata: {
        source: 'hybrid-hut-kiosk',
        membership: description,
      },
    });

    console.log(`✓ PaymentIntent created: ${paymentIntent.id} — £${(amount / 100).toFixed(2)}`);

    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
    });
  } catch (err) {
    console.error('PaymentIntent error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Process payment on WisePOS E Terminal (server-driven)
 *
 * This uses the server-driven integration where the backend
 * tells the reader what to do, rather than the JS SDK.
 * This is the recommended approach for WisePOS E.
 */
app.post('/api/process-terminal-payment', paymentLimiter, async (req, res) => {
  try {
    const { payment_intent_id } = req.body;
    const readerId = process.env.STRIPE_TERMINAL_READER_ID;

    if (!readerId) {
      return res.status(500).json({
        error: 'Terminal reader not configured. Set STRIPE_TERMINAL_READER_ID in .env'
      });
    }

    if (!payment_intent_id) {
      return res.status(400).json({ error: 'payment_intent_id is required' });
    }

    // Hand off the PaymentIntent to the physical reader
    const reader = await stripe.terminal.readers.processPaymentIntent(
      readerId,
      { payment_intent: payment_intent_id }
    );

    console.log(`✓ Payment sent to reader: ${readerId} (action: ${reader.action?.type})`);

    // Poll for payment completion
    const result = await pollPaymentIntent(payment_intent_id);

    res.json({
      status: result.status,
      payment_intent_id: result.id,
      amount: result.amount,
      message: result.status === 'succeeded'
        ? 'Payment successful'
        : `Payment status: ${result.status}`,
    });

  } catch (err) {
    console.error('Terminal payment error:', err.message);

    // Handle specific Stripe Terminal errors
    if (err.code === 'terminal_reader_busy') {
      return res.status(409).json({ error: 'Reader is busy. Please wait and try again.' });
    }
    if (err.code === 'terminal_reader_offline') {
      return res.status(503).json({ error: 'Reader is offline. Please check the device.' });
    }

    res.status(500).json({ error: err.message });
  }
});

/**
 * Cancel a reader action (e.g. if customer walks away)
 */
app.post('/api/cancel-reader-action', async (req, res) => {
  try {
    const readerId = process.env.STRIPE_TERMINAL_READER_ID;
    const reader = await stripe.terminal.readers.cancelAction(readerId);
    console.log('✓ Reader action cancelled');
    res.json({ status: 'cancelled', reader_status: reader.action });
  } catch (err) {
    console.error('Cancel action error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * List available readers (useful for debugging)
 */
app.get('/api/readers', async (req, res) => {
  try {
    const readers = await stripe.terminal.readers.list({ limit: 10 });
    res.json({
      readers: readers.data.map(r => ({
        id: r.id,
        label: r.label,
        status: r.status,
        device_type: r.device_type,
        ip_address: r.ip_address,
        location: r.location,
      })),
    });
  } catch (err) {
    console.error('List readers error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DB ROUTES — Products & Memberships
// ============================================================

/**
 * GET /api/products — returns active products
 */
app.get('/api/products', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE active = true ORDER BY name');
    res.json({ products: rows });
  } catch (err) {
    console.error('Get products error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/memberships — returns active memberships
 */
app.get('/api/memberships', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM memberships WHERE active = true ORDER BY price_pence');
    res.json({ memberships: rows });
  } catch (err) {
    console.error('Get memberships error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/verify — verify admin PIN
 */
app.post('/api/admin/verify', (req, res) => {
  const { pin } = req.body;
  if (String(pin) === String(process.env.ADMIN_PIN || '2200')) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid PIN' });
  }
});

/**
 * GET /api/admin/products — all products including inactive
 */
app.get('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products ORDER BY name');
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/products — create product
 */
app.post('/api/admin/products', requireAdmin, async (req, res) => {
  try {
    const { name, price_pence, category = 'product', inventory = 0, track_inventory = false, low_stock_threshold = 5 } = req.body;
    if (!name || !price_pence) return res.status(400).json({ error: 'name and price_pence required' });
    const { rows } = await pool.query(
      'INSERT INTO products (name, price_pence, category, inventory, track_inventory, low_stock_threshold) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [name, price_pence, category, inventory, track_inventory, low_stock_threshold]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/products/:id — update product
 */
app.put('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const { name, price_pence, category, active, inventory, track_inventory, low_stock_threshold } = req.body;
    const { rows } = await pool.query(
      `UPDATE products SET
        name = COALESCE($1, name),
        price_pence = COALESCE($2, price_pence),
        category = COALESCE($3, category),
        active = COALESCE($4, active),
        inventory = COALESCE($5, inventory),
        track_inventory = COALESCE($6, track_inventory),
        low_stock_threshold = COALESCE($7, low_stock_threshold),
        updated_at = NOW()
       WHERE id = $8 RETURNING *`,
      [name, price_pence, category, active, inventory, track_inventory, low_stock_threshold, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/products/:id — soft delete
 */
app.delete('/api/admin/products/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE products SET active = false, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/memberships — all memberships
 */
app.get('/api/admin/memberships', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM memberships ORDER BY price_pence');
    res.json({ memberships: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/memberships — create membership
 */
app.post('/api/admin/memberships', requireAdmin, async (req, res) => {
  try {
    const { name, price_pence, period, type = 'recurring' } = req.body;
    if (!name || !price_pence) return res.status(400).json({ error: 'name and price_pence required' });
    const { rows } = await pool.query(
      'INSERT INTO memberships (name, price_pence, period, type) VALUES ($1, $2, $3, $4) RETURNING *',
      [name, price_pence, period, type]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/memberships/:id — update membership
 */
app.put('/api/admin/memberships/:id', requireAdmin, async (req, res) => {
  try {
    const { name, price_pence, period, type, active } = req.body;
    const { rows } = await pool.query(
      'UPDATE memberships SET name = COALESCE($1, name), price_pence = COALESCE($2, price_pence), period = COALESCE($3, period), type = COALESCE($4, type), active = COALESCE($5, active), updated_at = NOW() WHERE id = $6 RETURNING *',
      [name, price_pence, period, type, active, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Membership not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/memberships/:id — soft delete
 */
app.delete('/api/admin/memberships/:id', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'UPDATE memberships SET active = false, updated_at = NOW() WHERE id = $1 RETURNING *',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Membership not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ADMIN ROUTES — Transactions
// ============================================================

app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 100);
    const list = await stripe.paymentIntents.list({ limit });
    const transactions = list.data.map(pi => ({
      id: pi.id,
      amount: pi.amount,
      currency: pi.currency,
      status: pi.status,
      description: pi.description || '',
      created: pi.created,
      created_display: new Date(pi.created * 1000).toLocaleString('en-GB', { timeZone: 'Europe/London' }),
    }));
    res.json({ transactions });
  } catch (err) {
    console.error('Transactions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/transactions/daily', requireAdmin, async (req, res) => {
  try {
    const list = await stripe.paymentIntents.list({ limit: 100 });
    const succeeded = list.data.filter(pi => pi.status === 'succeeded');
    const dailyMap = {};
    for (const pi of succeeded) {
      const date = new Date(pi.created * 1000).toLocaleDateString('en-GB', { timeZone: 'Europe/London' });
      if (!dailyMap[date]) dailyMap[date] = { date, total_pence: 0, count: 0 };
      dailyMap[date].total_pence += pi.amount;
      dailyMap[date].count += 1;
    }
    const daily = Object.values(dailyMap).sort((a, b) => {
      const [ad, am, ay] = a.date.split('/');
      const [bd, bm, by] = b.date.split('/');
      return new Date(`${by}-${bm}-${bd}`) - new Date(`${ay}-${am}-${ad}`);
    }).reverse();
    res.json({ daily });
  } catch (err) {
    console.error('Daily totals error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/refund', requireAdmin, async (req, res) => {
  try {
    const { payment_intent_id, amount } = req.body;
    if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id required' });

    const refundParams = { payment_intent: payment_intent_id };
    if (amount) refundParams.amount = parseInt(amount);

    const refund = await stripe.refunds.create(refundParams);

    console.log(`✓ Refund created: ${refund.id} — £${((refund.amount) / 100).toFixed(2)} — ${refund.status}`);

    res.json({
      id: refund.id,
      amount: refund.amount,
      status: refund.status,
      payment_intent: refund.payment_intent,
    });
  } catch (err) {
    console.error('Refund error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/stock/adjust', requireAdmin, async (req, res) => {
  try {
    const { product_id, quantity } = req.body;
    if (!product_id || quantity === undefined) return res.status(400).json({ error: 'product_id and quantity required' });
    const { rows } = await pool.query(
      'UPDATE products SET inventory = inventory + $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [parseInt(quantity), product_id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/stock/low', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM products WHERE track_inventory = true AND active = true AND inventory <= low_stock_threshold ORDER BY inventory ASC'
    );
    res.json({ products: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// MEMBER ROUTES
// ============================================================

/**
 * GET /api/members/search — search members by name or email (public, used at kiosk)
 */
app.get('/api/members/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json({ members: [] });
    const { rows } = await pool.query(
      `SELECT * FROM members WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 10`,
      [`%${q.trim()}%`]
    );
    res.json({ members: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/members — create a new member (public, new member at kiosk)
 */
app.post('/api/members', async (req, res) => {
  try {
    const { name, email, phone, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    const { rows } = await pool.query(
      'INSERT INTO members (name, email, phone, notes) VALUES ($1, $2, $3, $4) RETURNING *',
      [name.trim(), email || null, phone || null, notes || null]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/members/:id — get member by ID
 */
app.get('/api/members/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM members WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/members — list all members (admin)
 */
app.get('/api/admin/members', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM members ORDER BY name');
    res.json({ members: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/members/:id — update member (admin)
 */
app.put('/api/admin/members/:id', requireAdmin, async (req, res) => {
  try {
    const { name, email, phone, notes } = req.body;
    const { rows } = await pool.query(
      'UPDATE members SET name = COALESCE($1, name), email = COALESCE($2, email), phone = COALESCE($3, phone), notes = COALESCE($4, notes), updated_at = NOW() WHERE id = $5 RETURNING *',
      [name, email, phone, notes, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/members/:id — delete member (admin)
 */
app.delete('/api/admin/members/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM members WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SUBSCRIPTION ROUTES
// ============================================================

/**
 * POST /api/subscriptions/setup — set up recurring subscription after terminal payment
 */
app.post('/api/subscriptions/setup', async (req, res) => {
  try {
    const { payment_intent_id, member_id, membership_id } = req.body;
    if (!payment_intent_id || !member_id || !membership_id) {
      return res.status(400).json({ error: 'payment_intent_id, member_id, and membership_id are required' });
    }

    // Get the membership
    const { rows: membershipRows } = await pool.query('SELECT * FROM memberships WHERE id = $1', [membership_id]);
    if (!membershipRows.length) return res.status(404).json({ error: 'Membership not found' });
    const membership = membershipRows[0];

    // Get the member
    const { rows: memberRows } = await pool.query('SELECT * FROM members WHERE id = $1', [member_id]);
    if (!memberRows.length) return res.status(404).json({ error: 'Member not found' });
    const member = memberRows[0];

    // Retrieve the PaymentIntent to get the payment method
    const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (pi.status !== 'succeeded') {
      return res.status(400).json({ error: 'PaymentIntent has not succeeded' });
    }

    // Get the payment method from the charge
    const charges = await stripe.charges.list({ payment_intent: payment_intent_id, limit: 1 });
    if (!charges.data.length) return res.status(400).json({ error: 'No charge found for this payment' });
    const paymentMethodId = charges.data[0].payment_method;

    // Create or get Stripe customer
    let customerId;
    const { rows: existingSubs } = await pool.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE member_id = $1 AND stripe_customer_id IS NOT NULL LIMIT 1',
      [member_id]
    );
    if (existingSubs.length) {
      customerId = existingSubs[0].stripe_customer_id;
    } else {
      const customer = await stripe.customers.create({
        name: member.name,
        email: member.email || undefined,
        phone: member.phone || undefined,
        metadata: { hybrid_hut_member_id: String(member_id) },
      });
      customerId = customer.id;
    }

    // Attach payment method to customer
    await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    // Create or get Stripe Price for this membership
    let priceId = membership.stripe_price_id;
    if (!priceId) {
      const price = await stripe.prices.create({
        currency: 'gbp',
        unit_amount: membership.price_pence,
        recurring: { interval: 'month' },
        product_data: { name: membership.name },
      });
      priceId = price.id;
      await pool.query('UPDATE memberships SET stripe_price_id = $1 WHERE id = $2', [priceId, membership_id]);
    }

    // Create Stripe Subscription (trial_end = end of current period so they aren't charged again now)
    const periodEnd = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60); // 30 days from now
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      trial_end: periodEnd,
      default_payment_method: paymentMethodId,
      metadata: { hybrid_hut_member_id: String(member_id), membership_id: String(membership_id) },
    });

    // Store in DB
    const { rows: subRows } = await pool.query(
      `INSERT INTO subscriptions (member_id, stripe_customer_id, stripe_subscription_id, membership_id, status, current_period_end)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [member_id, customerId, subscription.id, membership_id, subscription.status, new Date(subscription.current_period_end * 1000)]
    );

    console.log(`✓ Subscription created: ${subscription.id} for member ${member.name}`);
    res.json({ subscription: subRows[0], stripe_subscription_id: subscription.id });
  } catch (err) {
    console.error('Subscription setup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/subscriptions — list all subscriptions with member and membership info (admin)
 */
app.get('/api/admin/subscriptions', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.*, m.name as member_name, m.email as member_email,
             ms.name as membership_name, ms.price_pence
      FROM subscriptions s
      LEFT JOIN members m ON s.member_id = m.id
      LEFT JOIN memberships ms ON s.membership_id = ms.id
      ORDER BY s.created_at DESC
    `);
    res.json({ subscriptions: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/subscriptions/:id/cancel — cancel a subscription (admin)
 */
app.post('/api/admin/subscriptions/:id/cancel', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Subscription not found' });
    const sub = rows[0];

    if (sub.stripe_subscription_id) {
      await stripe.subscriptions.cancel(sub.stripe_subscription_id);
    }

    const { rows: updated } = await pool.query(
      'UPDATE subscriptions SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      ['cancelled', req.params.id]
    );
    res.json(updated[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CASH PAYMENTS
// ============================================================

/**
 * POST /api/admin/cash — log a manual cash payment
 */
app.post('/api/admin/cash', requireAdmin, async (req, res) => {
  try {
    const { amount_pence, description, note } = req.body;
    if (!amount_pence || amount_pence < 1) return res.status(400).json({ error: 'amount_pence must be a positive integer' });
    const { rows } = await pool.query(
      'INSERT INTO cash_payments (amount_pence, description, note) VALUES ($1, $2, $3) RETURNING *',
      [amount_pence, description || null, note || null]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('Log cash error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/cash — list cash payments, optional ?date=YYYY-MM-DD filter
 */
app.get('/api/admin/cash', requireAdmin, async (req, res) => {
  try {
    const { date } = req.query;
    let query = 'SELECT * FROM cash_payments';
    const params = [];
    if (date) {
      query += ' WHERE created_at::date = $1';
      params.push(date);
    }
    query += ' ORDER BY created_at DESC LIMIT 200';
    const { rows } = await pool.query(query, params);
    const total = rows.reduce((s, r) => s + r.amount_pence, 0);
    res.json({ cash_payments: rows, total_pence: total });
  } catch (err) {
    console.error('Get cash error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/cash/:id — delete a cash entry
 */
app.delete('/api/admin/cash/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM cash_payments WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete cash error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// DISCOUNT CODES
// ============================================================

/**
 * POST /api/discount/validate — validate a discount code (public, used at kiosk)
 * Body: { code, amount_pence }
 * Returns: { valid, discount_pence, final_pence, type, value, code_id, message }
 */
app.post('/api/discount/validate', async (req, res) => {
  try {
    const { code, amount_pence } = req.body;
    if (!code || !amount_pence) return res.status(400).json({ error: 'code and amount_pence required' });
    const { rows } = await pool.query(
      'SELECT * FROM discount_codes WHERE UPPER(code) = UPPER($1) AND active = true',
      [code.trim()]
    );
    if (!rows.length) return res.json({ valid: false, message: 'Invalid or expired discount code' });
    const dc = rows[0];
    if (dc.expires_at && new Date(dc.expires_at) < new Date()) {
      return res.json({ valid: false, message: 'This discount code has expired' });
    }
    if (dc.max_uses !== null && dc.uses_count >= dc.max_uses) {
      return res.json({ valid: false, message: 'This discount code has reached its maximum uses' });
    }
    let discount_pence = 0;
    if (dc.type === 'percent') {
      discount_pence = Math.round(amount_pence * dc.value / 100);
    } else {
      discount_pence = Math.min(dc.value, amount_pence);
    }
    const final_pence = Math.max(100, amount_pence - discount_pence); // min £1
    res.json({ valid: true, discount_pence, final_pence, type: dc.type, value: dc.value, code_id: dc.id, message: `Code applied: ${dc.type === 'percent' ? dc.value + '% off' : '£' + (dc.value/100).toFixed(2) + ' off'}` });
  } catch (err) {
    console.error('Discount validate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/discount/redeem — increment uses_count after successful payment
 * Body: { code_id }
 */
app.post('/api/discount/redeem', async (req, res) => {
  try {
    const { code_id } = req.body;
    if (!code_id) return res.status(400).json({ error: 'code_id required' });
    await pool.query('UPDATE discount_codes SET uses_count = uses_count + 1 WHERE id = $1', [code_id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Discount redeem error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/discounts — list all discount codes
 */
app.get('/api/admin/discounts', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM discount_codes ORDER BY created_at DESC');
    res.json({ discounts: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/discounts — create a discount code
 * Body: { code, type, value, max_uses?, expires_at? }
 */
app.post('/api/admin/discounts', requireAdmin, async (req, res) => {
  try {
    const { code, type, value, max_uses, expires_at } = req.body;
    if (!code || !type || value == null) return res.status(400).json({ error: 'code, type, value required' });
    if (!['percent','fixed'].includes(type)) return res.status(400).json({ error: 'type must be percent or fixed' });
    if (type === 'percent' && (value < 1 || value > 100)) return res.status(400).json({ error: 'percent value must be 1-100' });
    const { rows } = await pool.query(
      'INSERT INTO discount_codes (code, type, value, max_uses, expires_at) VALUES (UPPER($1),$2,$3,$4,$5) RETURNING *',
      [code.trim(), type, value, max_uses || null, expires_at || null]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A code with that name already exists' });
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/discounts/:id — update a discount code
 */
app.put('/api/admin/discounts/:id', requireAdmin, async (req, res) => {
  try {
    const { active, max_uses, expires_at } = req.body;
    const { rows } = await pool.query(
      'UPDATE discount_codes SET active = COALESCE($1, active), max_uses = COALESCE($2, max_uses), expires_at = COALESCE($3, expires_at) WHERE id = $4 RETURNING *',
      [active, max_uses, expires_at, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/admin/discounts/:id — deactivate (soft delete)
 */
app.delete('/api/admin/discounts/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE discount_codes SET active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ANALYTICS
// ============================================================

/**
 * GET /api/admin/analytics — summary stats + by-product breakdown from Stripe
 */
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
  try {
    const { days = 30 } = req.query;
    const since = Math.floor(Date.now() / 1000) - (parseInt(days) * 86400);

    // Fetch up to 100 succeeded payment intents
    const intents = await stripe.paymentIntents.list({ limit: 100, created: { gte: since } });
    const succeeded = intents.data.filter(pi => pi.status === 'succeeded');

    const totalRevenue = succeeded.reduce((s, pi) => s + pi.amount, 0);
    const count = succeeded.length;
    const avgTransaction = count ? Math.round(totalRevenue / count) : 0;

    // By product/description
    const byProduct = {};
    succeeded.forEach(pi => {
      const key = pi.description || 'Unknown';
      if (!byProduct[key]) byProduct[key] = { count: 0, total: 0 };
      byProduct[key].count++;
      byProduct[key].total += pi.amount;
    });
    const byProductArr = Object.entries(byProduct)
      .map(([name, d]) => ({ name, count: d.count, total_pence: d.total }))
      .sort((a, b) => b.total_pence - a.total_pence);

    // By hour of day
    const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: 0, total: 0 }));
    succeeded.forEach(pi => {
      const h = new Date(pi.created * 1000).getHours();
      byHour[h].count++;
      byHour[h].total += pi.amount;
    });

    // By day
    const byDay = {};
    succeeded.forEach(pi => {
      const d = new Date(pi.created * 1000).toLocaleDateString('en-GB');
      if (!byDay[d]) byDay[d] = { date: d, count: 0, total: 0 };
      byDay[d].count++;
      byDay[d].total += pi.amount;
    });
    const byDayArr = Object.values(byDay).sort((a, b) => {
      const parse = s => { const [d,m,y] = s.split('/'); return new Date(y,m-1,d); };
      return parse(a.date) - parse(b.date);
    });

    res.json({ total_revenue_pence: totalRevenue, transaction_count: count, avg_transaction_pence: avgTransaction, by_product: byProductArr, by_hour: byHour, by_day: byDayArr, days: parseInt(days) });
  } catch (err) {
    console.error('Analytics error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// HELPERS
// ============================================================

/**
 * Poll a PaymentIntent until it reaches a terminal state.
 * The WisePOS E processes the card and Stripe updates the PI status.
 */
async function pollPaymentIntent(paymentIntentId, maxAttempts = 60, interval = 2000) {
  let seenProcessing = false;

  for (let i = 0; i < maxAttempts; i++) {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (pi.status === 'processing') seenProcessing = true;

    if (pi.status === 'succeeded' || pi.status === 'canceled') {
      return pi;
    }

    // requires_payment_method is the initial state — only treat it as a
    // terminal failure if the card was already attempted (seenProcessing)
    if (pi.status === 'requires_payment_method' && seenProcessing) {
      return pi;
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error('Payment timed out. The reader may still be waiting for a card.');
}

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║     HYBRID HUT — Terminal Payment Server      ║
  ║     Running on http://localhost:${PORT}          ║
  ╚═══════════════════════════════════════════════╝
  `);

  if (!process.env.STRIPE_SECRET_KEY) {
    console.warn('⚠ STRIPE_SECRET_KEY not set — payments will fail!');
  }
  if (!process.env.STRIPE_TERMINAL_READER_ID) {
    console.warn('⚠ STRIPE_TERMINAL_READER_ID not set — terminal payments will fail!');
  }
});
