// In-memory cart for the mockups. No network, no Shopify. Wires:
//   [data-add="SKU"]        add one of SKU (optional data-qty)
//   [data-cart-open]        open the drawer
//   [data-cart-count]       badge text (hidden when 0)
//   [data-cart-count-always] count text, always shown
//   [data-cart-subtotal]    subtotal text
//   [data-cart-lines]       optional inline list (e.g. datasheet BOM rail)
(function () {
  const lines = new Map(); // sku -> qty
  const money = (n) => '$' + n.toFixed(2);
  const count = () => [...lines.values()].reduce((a, b) => a + b, 0);
  const subtotal = () => [...lines].reduce((a, [sku, q]) => a + (MOCK.productBySku(sku)?.price || 0) * q, 0);

  function lineRows(compact) {
    if (lines.size === 0) return `<p class="text-zinc-500 text-sm">Nothing here yet.</p>`;
    return [...lines].map(([sku, q]) => {
      const p = MOCK.productBySku(sku);
      return `<div class="flex items-start justify-between gap-3 ${compact ? 'py-1.5' : 'py-3 border-b border-zinc-800'}" data-line="${sku}">
        <div class="min-w-0">
          <div class="font-semibold text-sm truncate">${p.name}</div>
          <div class="font-mono text-xs text-zinc-400">${sku} · ${money(p.price)}</div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          <button class="w-7 h-7 rounded border border-zinc-700 hover:border-cyan-400" data-qty="-1" aria-label="Decrease">−</button>
          <span class="font-mono w-6 text-center text-sm">${q}</span>
          <button class="w-7 h-7 rounded border border-zinc-700 hover:border-cyan-400" data-qty="1" aria-label="Increase">+</button>
        </div>
      </div>`;
    }).join('');
  }

  function drawer() {
    let el = document.getElementById('mock-cart-drawer');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'mock-cart-drawer';
    el.className = 'fixed inset-0 z-[100] hidden';
    el.innerHTML = `
      <div class="absolute inset-0 bg-black/60" data-cart-close></div>
      <aside role="dialog" aria-label="Cart" class="absolute right-0 top-0 h-full w-full max-w-md bg-zinc-900 border-l border-zinc-800 flex flex-col">
        <header class="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 class="font-bold">Cart</h2>
          <button class="text-zinc-400 hover:text-white text-xl leading-none" data-cart-close aria-label="Close">×</button>
        </header>
        <div class="flex-1 overflow-y-auto px-5" data-drawer-lines></div>
        <footer class="px-5 py-4 border-t border-zinc-800 space-y-3">
          <div class="flex justify-between font-mono text-sm"><span class="text-zinc-400">Subtotal</span><span data-cart-subtotal>$0.00</span></div>
          <button class="w-full py-3 bg-white text-black font-bold rounded-lg hover:bg-cyan-400 transition-colors" data-checkout>Checkout on Shopify</button>
          <p class="text-xs text-zinc-500">Mockup: checkout would redirect to Shopify’s hosted checkout. This site never handles card details.</p>
        </footer>
      </aside>`;
    document.body.appendChild(el);
    el.querySelectorAll('[data-cart-close]').forEach((b) => b.addEventListener('click', close));
    el.querySelector('[data-checkout]').addEventListener('click', () => {
      const btn = el.querySelector('[data-checkout]');
      btn.textContent = 'Redirecting to checkout… (mock)';
      setTimeout(() => (btn.textContent = 'Checkout on Shopify'), 1500);
    });
    return el;
  }

  function render() {
    const n = count();
    document.querySelectorAll('[data-cart-count]').forEach((c) => { c.textContent = n; c.classList.toggle('hidden', n === 0); });
    document.querySelectorAll('[data-cart-count-always]').forEach((c) => (c.textContent = n));
    document.querySelectorAll('[data-cart-subtotal]').forEach((s) => (s.textContent = money(subtotal())));
    document.querySelectorAll('[data-cart-lines]').forEach((l) => (l.innerHTML = lineRows(true)));
    const d = document.getElementById('mock-cart-drawer');
    if (d) d.querySelector('[data-drawer-lines]').innerHTML = lineRows(false);
  }

  function open() { drawer().classList.remove('hidden'); render(); }
  function close() { drawer().classList.add('hidden'); }

  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const sku = add.dataset.add;
      lines.set(sku, (lines.get(sku) || 0) + Number(add.dataset.qty || 1));
      render();
      if (!add.hasAttribute('data-quiet')) open();
      add.classList.add('ring-2', 'ring-cyan-400');
      setTimeout(() => add.classList.remove('ring-2', 'ring-cyan-400'), 400);
      return;
    }
    if (e.target.closest('[data-cart-open]')) { open(); return; }
    const qty = e.target.closest('[data-qty]');
    if (qty) {
      const sku = qty.closest('[data-line]').dataset.line;
      const q = (lines.get(sku) || 0) + Number(qty.dataset.qty);
      q <= 0 ? lines.delete(sku) : lines.set(sku, q);
      render();
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  window.MockCart = { open, close, render };
  document.addEventListener('DOMContentLoaded', render);
})();
