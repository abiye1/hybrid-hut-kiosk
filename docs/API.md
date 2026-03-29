# API Reference

Base URL: `https://membership.hybridhut.co.uk/api`

All request bodies are JSON. All responses are JSON.

---

## Public Endpoints

### GET /health
Health check.

**Response:**
```json
{ "status": "ok", "timestamp": "2026-03-28T13:00:00.000Z" }
```

---

### GET /products
List all active products.

**Response:**
```json
{
  "products": [
    { "id": 1, "name": "Actiph Electrolyte water", "price_pence": 200, "category": "product", "active": true, "created_at": "...", "updated_at": "..." }
  ]
}
```

---

### GET /memberships
List all active membership plans.

**Response:**
```json
{
  "memberships": [
    { "id": 1, "name": "Gym Membership", "price_pence": 4000, "period": "per month", "type": "recurring", "active": true, "created_at": "...", "updated_at": "..." }
  ]
}
```

---

### POST /connection-token
Create a Stripe Terminal connection token (used by Terminal JS SDK).

**Response:**
```json
{ "secret": "pst_test_..." }
```

---

### POST /create-payment-intent
Create a Stripe PaymentIntent for the selected amount.

**Request:**
```json
{ "amount": 4000, "currency": "gbp", "description": "Gym Membership" }
```
- `amount`: integer in pence (minimum 100 = £1.00)
- `currency`: always `"gbp"`
- `description`: shown in Stripe Dashboard

**Response:**
```json
{ "client_secret": "pi_xxx_secret_xxx", "payment_intent_id": "pi_xxx" }
```

---

### POST /process-terminal-payment
Send a PaymentIntent to the WisePOS E reader. Polls until complete (up to 2 minutes).

**Request:**
```json
{ "payment_intent_id": "pi_xxx" }
```

**Response (success):**
```json
{ "status": "succeeded", "payment_intent_id": "pi_xxx", "amount": 4000, "message": "Payment successful" }
```

**Response (failure):**
```json
{ "status": "requires_payment_method", "payment_intent_id": "pi_xxx", "amount": 4000, "message": "Payment status: requires_payment_method" }
```

**Error responses:**
- `409` — `"Reader is busy. Please wait and try again."`
- `503` — `"Reader is offline. Please check the device."`

---

### POST /cancel-reader-action
Cancel any pending action on the reader.

**Response:**
```json
{ "status": "cancelled", "reader_status": null }
```

---

### GET /readers
List all registered Stripe Terminal readers.

**Response:**
```json
{
  "readers": [
    { "id": "tmr_xxx", "label": "Front desk Hybrid hut", "status": "online", "device_type": "bbpos_wisepos_e", "ip_address": "192.168.1.x", "location": "tml_xxx" }
  ]
}
```

---

## Admin Endpoints

> Admin endpoints are protected by PIN `2200` verified client-side. The backend does not enforce authentication on these routes — a future improvement is to add server-side middleware.

### POST /admin/verify
Verify the admin PIN.

**Request:**
```json
{ "pin": "2200" }
```

**Response (success):**
```json
{ "success": true }
```

**Response (failure):**
```json
{ "success": false, "error": "Invalid PIN" }
```

---

### GET /admin/products
List all products including inactive.

**Response:**
```json
{ "products": [ { "id": 1, "name": "...", "price_pence": 200, "active": false, ... } ] }
```

---

### POST /admin/products
Create a new product.

**Request:**
```json
{ "name": "Protein Cookie", "price_pence": 250, "category": "product" }
```

**Response:** The created product row.

---

### PUT /admin/products/:id
Update a product. All fields optional (PATCH semantics).

**Request:**
```json
{ "name": "Protein Cookie", "price_pence": 300, "active": true }
```

**Response:** The updated product row.

---

### DELETE /admin/products/:id
Soft-delete a product (sets `active = false`).

**Response:**
```json
{ "success": true }
```

---

### GET /admin/memberships
List all memberships including inactive.

---

### POST /admin/memberships
Create a membership plan.

**Request:**
```json
{ "name": "Student Membership", "price_pence": 2500, "period": "per month", "type": "recurring" }
```

---

### PUT /admin/memberships/:id
Update a membership. All fields optional.

---

### DELETE /admin/memberships/:id
Soft-delete a membership.

---

### GET /admin/transactions
Fetch the last 100 PaymentIntents from Stripe.

**Query params:** `?limit=50` (max 100)

**Response:**
```json
{
  "transactions": [
    {
      "id": "pi_xxx",
      "amount": 4000,
      "currency": "gbp",
      "status": "succeeded",
      "description": "Gym Membership",
      "created": 1743173169,
      "created_display": "28/03/2026, 15:26:09"
    }
  ]
}
```

---

### GET /admin/transactions/daily
Succeeded PaymentIntents grouped by day (Europe/London timezone).

**Response:**
```json
{
  "daily": [
    { "date": "28/03/2026", "total_pence": 2110, "count": 6 }
  ]
}
```
