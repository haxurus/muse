'use strict';

/*
 * Muse public home — progressive enhancement only (the page works without it).
 * Closes the mobile <details> menu after picking a link, on Escape and on outside clicks.
 */

const closeMenus = except => {
  for (const menu of document.querySelectorAll('.site-mobile-menu[open]')) {
    if (menu !== except) menu.open = false;
  }
};

document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  const menu = target.closest('.site-mobile-menu');
  if (menu && target.closest('a')) {
    menu.open = false;
    return;
  }

  closeMenus(menu);
});

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;

  const open = document.querySelector('.site-mobile-menu[open]');
  if (!open) return;

  open.open = false;
  const summary = open.querySelector('summary');
  if (summary) summary.focus();
});
