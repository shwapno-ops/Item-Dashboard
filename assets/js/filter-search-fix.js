(() => {
  'use strict';

  const FILTER_SELECTOR = 'details.sidebar-filter[data-filter-details]';
  const SEARCH_SELECTOR = 'input.sidebar-filter-search[data-multi-search]';

  const normalizeSearch = value => String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .trim();

  function updateSearchIndex(details) {
    details.querySelectorAll('.sidebar-filter-option').forEach(option => {
      const input = option.querySelector('input');
      const label = option.querySelector('span')?.textContent || option.textContent || '';
      const value = input?.value || '';
      // Search both the actual filter value/ID and the visible label/name.
      option.dataset.optionSearch = normalizeSearch(`${value} ${label}`);
    });
  }

  function ensureNoResultsMessage(details) {
    const options = details.querySelector('.sidebar-filter-options');
    if (!options || options.querySelector('.sidebar-filter-no-results')) return;
    const message = document.createElement('div');
    message.className = 'sidebar-filter-no-results';
    message.hidden = true;
    message.textContent = 'No matching options';
    options.appendChild(message);
  }

  function updateNoResults(details) {
    const search = details.querySelector(SEARCH_SELECTOR);
    const message = details.querySelector('.sidebar-filter-no-results');
    if (!search || !message) return;

    const query = normalizeSearch(search.value);
    const options = [...details.querySelectorAll('.sidebar-filter-option')];
    const visibleCount = options.filter(option => !option.hidden).length;
    message.hidden = !query || visibleCount > 0;
  }

  function enhanceFilter(details) {
    if (!(details instanceof HTMLElement) || !details.matches(FILTER_SELECTOR)) return;

    const search = details.querySelector(SEARCH_SELECTOR);
    if (!search) return;

    search.placeholder = `Type to search ${details.dataset.filterDetails || 'filter'}…`;
    search.setAttribute('aria-label', search.placeholder.replace('…', ''));
    search.setAttribute('autocomplete', 'off');
    search.setAttribute('autocapitalize', 'none');
    search.spellcheck = false;

    updateSearchIndex(details);
    ensureNoResultsMessage(details);
    updateNoResults(details);
  }

  function enhanceAll(root = document) {
    if (root instanceof HTMLElement && root.matches(FILTER_SELECTOR)) enhanceFilter(root);
    root.querySelectorAll?.(FILTER_SELECTOR).forEach(enhanceFilter);
  }

  function closeOtherFilters(active) {
    document.querySelectorAll(`${FILTER_SELECTOR}[open]`).forEach(details => {
      if (details !== active) details.removeAttribute('open');
    });
  }

  // The dashboard redraws the filters after every selection. Re-apply the search
  // enhancements whenever that happens, without touching the dashboard calculations.
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      enhanceAll();
    });
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  enhanceAll();

  // Opening a filter immediately puts the cursor in its search box.
  document.addEventListener('toggle', event => {
    const details = event.target;
    if (!(details instanceof HTMLElement) || !details.matches(FILTER_SELECTOR) || !details.open) return;

    closeOtherFilters(details);
    enhanceFilter(details);
    requestAnimationFrame(() => {
      const search = details.querySelector(SEARCH_SELECTOR);
      search?.focus({ preventScroll: true });
      search?.select();
    });
  }, true);

  // Keep the no-result state in sync after the dashboard's own search listener runs.
  document.addEventListener('input', event => {
    const search = event.target.closest?.(SEARCH_SELECTOR);
    if (!search) return;
    const details = search.closest(FILTER_SELECTOR);
    if (!details) return;
    updateSearchIndex(details);
    requestAnimationFrame(() => updateNoResults(details));
  });

  // Keyboard convenience: when a filter header is focused, typing opens the filter
  // and starts searching immediately. Escape clears search first, then closes it.
  document.addEventListener('keydown', event => {
    const search = event.target.closest?.(SEARCH_SELECTOR);
    if (search && event.key === 'Escape') {
      const details = search.closest(FILTER_SELECTOR);
      if (search.value) {
        event.preventDefault();
        search.value = '';
        search.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (details) {
        event.preventDefault();
        details.removeAttribute('open');
        details.querySelector('summary')?.focus();
      }
      return;
    }

    const summary = event.target.closest?.('summary');
    const details = summary?.parentElement;
    if (!details?.matches?.(FILTER_SELECTOR)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;

    event.preventDefault();
    details.setAttribute('open', '');
    closeOtherFilters(details);
    enhanceFilter(details);

    requestAnimationFrame(() => {
      const target = details.querySelector(SEARCH_SELECTOR);
      if (!target) return;
      target.focus({ preventScroll: true });
      target.value = event.key;
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  });
})();
