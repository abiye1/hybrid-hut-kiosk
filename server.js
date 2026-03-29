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

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
}));
app.use(express.json());

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
app.post('/api/create-payment-intent', async (req, res) => {
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
app.post('/api/process-terminal-payment', async (req, res) => {
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
  if (String(pin) === '2200') {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid PIN' });
  }
});

/**
 * GET /api/admin/products — all products including inactive
 */
app.get('/api/admin/products', async (req, res) => {
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
app.post('/api/admin/products', async (req, res) => {
  try {
    const { name, price_pence, category = 'product' } = req.body;
    if (!name || !price_pence) return res.status(400).json({ error: 'name and price_pence required' });
    const { rows } = await pool.query(
      'INSERT INTO products (name, price_pence, category) VALUES ($1, $2, $3) RETURNING *',
      [name, price_pence, category]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/admin/products/:id — update product
 */
app.put('/api/admin/products/:id', async (req, res) => {
  try {
    const { name, price_pence, category, active } = req.body;
    const { rows } = await pool.query(
      'UPDATE products SET name = COALESCE($1, name), price_pence = COALESCE($2, price_pence), category = COALESCE($3, category), active = COALESCE($4, active), updated_at = NOW() WHERE id = $5 RETURNING *',
      [name, price_pence, category, active, req.params.id]
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
app.delete('/api/admin/products/:id', async (req, res) => {
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
app.get('/api/admin/memberships', async (req, res) => {
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
app.post('/api/admin/memberships', async (req, res) => {
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
app.put('/api/admin/memberships/:id', async (req, res) => {
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
app.delete('/api/admin/memberships/:id', async (req, res) => {
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

app.get('/api/admin/transactions', async (req, res) => {
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

app.get('/api/admin/transactions/daily', async (req, res) => {
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
