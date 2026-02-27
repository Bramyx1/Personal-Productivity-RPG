# Ugandan Handmade Store

A ready-to-run ecommerce website with products, images, auto-pricing, cart, and checkout.

## Start Here (2 steps)

1. In this folder, run:

```bash
npm start
```

2. Open:

`http://localhost:3000`

That is it. The store is live locally.

## How selling works

- Products are stored in `public/data/products.json`.
- Sale prices are generated automatically from each product `baseCost`.
- Checkout supports:
  - Credit/debit cards (Stripe)
  - Bank transfer
  - Cash on delivery

## Turn on real credit card payments

Set these before starting:

```bash
export STRIPE_SECRET_KEY=your_stripe_secret_key
export BASE_URL=http://localhost:3000
npm start
```

If `STRIPE_SECRET_KEY` is missing, card checkout stays in demo mode.

## Files you may care about

- `public/data/products.json`: product list and costs
- `public/index.html`: page structure
- `public/styles.css`: design and layout
- `public/store.js`: cart and checkout behavior
- `server.js`: pricing logic + API endpoints
