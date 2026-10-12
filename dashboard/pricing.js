/* Pricing page: monthly / yearly toggle (the server renders both prices). */
(() => {
  const grid = document.getElementById('plan-grid');
  const buttons = [...document.querySelectorAll('.billing-toggle button')];
  if (!grid || buttons.length === 0) return;

  for (const button of buttons) {
    button.addEventListener('click', () => {
      grid.dataset.billing = button.dataset.billing;
      for (const other of buttons) {
        const active = other === button;
        other.classList.toggle('is-active', active);
        other.setAttribute('aria-pressed', active ? 'true' : 'false');
      }
    });
  }
})();
