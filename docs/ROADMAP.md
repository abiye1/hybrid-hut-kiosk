# Feature Roadmap

## Phase 1 — High Impact (Quick Wins)

These features have the most immediate business value and are relatively self-contained.

| Feature | Description | Complexity |
|---------|-------------|------------|
| **Recurring subscriptions** | Save card from first terminal payment, create Stripe Subscription for automatic monthly billing | Medium |
| **Stock/inventory tracking** | Decrement on sale, low-stock alerts, out-of-stock hides product, admin top-up | Medium |
| **Refunds from admin** | Full or partial refunds via `stripe.refunds.create()`, shown in transaction history | Low |
| **End-of-day reports** | Open/close day, daily cash-up summary, printable format | Medium |
| **Member lookup at POS** | Search by name/email before charging, attach payment to member profile | High |
| **Failed payment retry** | Prompt customer to tap again without creating a new intent | Low |

---

## Phase 2 — Medium Priority

| Feature | Description | Complexity |
|---------|-------------|------------|
| **Discount codes / vouchers** | Fixed or percentage off, single/multi-use, admin interface | Medium |
| **Email/SMS receipts** | Prompt after payment, send via Stripe or Twilio | Low |
| **Tipping** | Tip prompt before payment, configurable amounts | Low |
| **Loyalty/rewards points** | Earn points per £ spent, redeem for discounts | High |
| **CSV export** | Download transaction history filtered by date range | Low |
| **Revenue analytics** | Revenue by product/category, hourly heatmaps, profit margin | Medium |
| **Split payments** | Split across multiple cards | Medium |
| **Cash tracking** | Log cash payments manually, end-of-day cash reconciliation | Low |
| **VAT reporting** | Taxable vs non-taxable split, VAT report for accounting | Medium |
| **Receipt printing** | Use WisePOS E built-in receipt printer | Medium |
| **Promotional pricing** | Time-limited sale prices, scheduled price changes | Medium |

---

## Phase 3 — Long Term

| Feature | Description | Complexity |
|---------|-------------|------------|
| **Stripe webhook integration** | Replace polling with `payment_intent.succeeded` webhook | Low |
| **Recurring billing / dunning** | Handle failed subscription payments automatically | Medium |
| **Membership expiry tracking** | Flag expired members at POS, renewal reminders via email/SMS | Medium |
| **Digital membership cards** | QR code on signup, scan at door for check-in, attendance log | High |
| **Offline mode** | Queue sales locally, sync when reconnected, offline indicator | High |
| **Multi-location support** | Different plans/products per location, location selector | High |
| **Role-based staff logins** | Individual staff PINs, sales attributed per employee | Medium |
| **Audit log** | Record every admin action with timestamp and user | Low |
| **Two-factor admin** | TOTP instead of static PIN | Medium |
| **Xero/QuickBooks integration** | Push transactions to accounting software automatically | High |
| **Google Sheets sync** | Live sync of sales data to a spreadsheet | Medium |
| **Barcode/QR scanning** | USB scanner to add products to cart | Medium |
| **Gym software integration** | Sync with Mindbody, Glofox, TeamUp etc. | High |
| **Waiver / consent signing** | Digital signature on-screen for new joins | Medium |
| **On-screen upsells** | "You bought a class pass — add a protein bar?" | Low |
| **Language selection** | Multi-language kiosk UI | Medium |

---

## Technical Debt / Infrastructure

| Item | Description |
|------|-------------|
| Server-side admin auth | Admin endpoints currently rely on client-side PIN check only |
| Webhook vs polling | Replace `pollPaymentIntent` with Stripe webhooks |
| `updated_at` trigger | Add PostgreSQL trigger to auto-update `updated_at` on every row change |
| Environment-based PIN | Move admin PIN from hardcoded `2200` to environment variable |
| Rate limiting | Add express-rate-limit to API endpoints |
| Input validation | Add server-side validation middleware (e.g. Zod or Joi) |
| Error monitoring | Integrate Sentry or similar for production error tracking |
| Database migrations | Add a migration tool (e.g. Flyway or node-pg-migrate) |
