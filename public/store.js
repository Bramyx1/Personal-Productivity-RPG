const state = {
  products: [],
  pricing: null,
  cart: new Map()
};

const productGrid = document.getElementById('product-grid');
const productTemplate = document.getElementById('product-template');
const cartPanel = document.getElementById('cart-panel');
const cartCount = document.getElementById('cart-count');
const cartItemsEl = document.getElementById('cart-items');
const cartTotalEl = document.getElementById('cart-total');
const checkoutMessage = document.getElementById('checkout-message');
const pricingNote = document.getElementById('pricing-note');
const statsEl = document.getElementById('store-stats');

function toMoney(v) {
  return `$${v.toFixed(2)}`;
}

function getCartItems() {
  return [...state.cart.entries()].map(([id, qty]) => ({ id, qty }));
}

function getTotals() {
  const catalog = new Map(state.products.map((p) => [p.id, p]));
  return getCartItems().reduce((acc, item) => {
    const product = catalog.get(item.id);
    if (!product) return acc;
    acc.count += item.qty;
    acc.total += product.price * item.qty;
    return acc;
  }, { count: 0, total: 0 });
}

function renderStats() {
  const productCount = state.products.length;
  const avgPrice = productCount
    ? state.products.reduce((sum, p) => sum + p.price, 0) / productCount
    : 0;
  const avgNet = productCount
    ? state.products.reduce((sum, p) => sum + p.estimatedNet, 0) / productCount
    : 0;

  statsEl.innerHTML = `
    <article class="stat">
      <span class="label">Products Live</span>
      <span class="value">${productCount}</span>
    </article>
    <article class="stat">
      <span class="label">Average Price</span>
      <span class="value">${toMoney(avgPrice)}</span>
    </article>
    <article class="stat">
      <span class="label">Estimated Net / Item</span>
      <span class="value">${toMoney(avgNet)}</span>
    </article>
  `;
}

function renderProducts() {
  productGrid.innerHTML = '';

  state.products.forEach((product, idx) => {
    const fragment = productTemplate.content.cloneNode(true);
    const article = fragment.querySelector('.card');
    article.style.animationDelay = `${idx * 45}ms`;

    fragment.querySelector('.card-image').src = product.image;
    fragment.querySelector('.card-image').alt = product.name;
    fragment.querySelector('.region').textContent = product.region;
    fragment.querySelector('.name').textContent = product.name;
    fragment.querySelector('.story').textContent = product.story;
    fragment.querySelector('.materials').textContent = `Materials: ${product.materials.join(', ')}`;
    fragment.querySelector('.price').textContent = toMoney(product.price);
    fragment.querySelector('.add').addEventListener('click', () => addToCart(product.id));

    productGrid.appendChild(fragment);
  });
}

function addToCart(productId) {
  const currentQty = state.cart.get(productId) || 0;
  state.cart.set(productId, currentQty + 1);
  renderCart();
}

function updateQty(productId, qty) {
  if (qty <= 0) {
    state.cart.delete(productId);
  } else {
    state.cart.set(productId, qty);
  }
  renderCart();
}

function renderCart() {
  const catalog = new Map(state.products.map((p) => [p.id, p]));
  cartItemsEl.innerHTML = '';

  getCartItems().forEach(({ id, qty }) => {
    const product = catalog.get(id);
    if (!product) return;

    const row = document.createElement('div');
    row.className = 'cart-item';
    row.innerHTML = `
      <span class="cart-item-name">${product.name}</span>
      <input class="qty" type="number" min="0" value="${qty}" />
      <span>${toMoney(product.price * qty)}</span>
    `;

    row.querySelector('input').addEventListener('input', (event) => {
      const nextQty = Number(event.target.value);
      if (Number.isFinite(nextQty)) updateQty(id, nextQty);
    });

    cartItemsEl.appendChild(row);
  });

  const totals = getTotals();
  cartCount.textContent = String(totals.count);
  cartTotalEl.textContent = toMoney(totals.total);
}

async function checkout() {
  checkoutMessage.textContent = '';

  const items = getCartItems();
  if (!items.length) {
    checkoutMessage.textContent = 'Your cart is empty. Add products first.';
    return;
  }

  const method = document.getElementById('payment-method').value;

  const response = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, method })
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    checkoutMessage.textContent = data.error || 'Checkout failed. Please retry.';
    return;
  }

  if (data.checkoutUrl) {
    if (data.demoMode) {
      checkoutMessage.textContent = 'Demo checkout is on. Add STRIPE_SECRET_KEY for live cards.';
      setTimeout(() => {
        window.location.href = data.checkoutUrl;
      }, 800);
      return;
    }

    window.location.href = data.checkoutUrl;
    return;
  }

  checkoutMessage.textContent = data.message || 'Order placed.';
}

async function init() {
  const response = await fetch('/api/products');
  const data = await response.json();
  state.products = data.products || [];
  state.pricing = data.pricing || null;

  const marginPct = Math.round((state.pricing?.targetMargin || 0) * 100);
  pricingNote.textContent = `Auto-pricing is active: each item targets about ${marginPct}% margin after payment fees and delivery buffer.`;

  renderStats();
  renderProducts();
  renderCart();
}

document.getElementById('cart-toggle').addEventListener('click', () => {
  cartPanel.classList.toggle('hidden');
});

document.getElementById('close-cart').addEventListener('click', () => {
  cartPanel.classList.add('hidden');
});

document.getElementById('checkout-btn').addEventListener('click', checkout);

init().catch((error) => {
  checkoutMessage.textContent = `Store failed to load: ${error.message}`;
});
