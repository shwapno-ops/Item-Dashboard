(() => {
  'use strict';

  const FILTER_SELECTOR = 'details.sidebar-filter[data-filter-details]';
  const SEARCH_SELECTOR = 'input.sidebar-filter-search[data-multi-search]';
  const OPTION_SELECTOR = '.sidebar-filter-option';

  const normalize = value => String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  const FILTER_LABELS = {
    regional: 'Regional Head',
    zone: 'Zonal Name',
    outlet: 'Outlet',
    division: 'Division',
    cat01: 'Cat 01',
    cat03: 'Cat 03'
  };

  function labelFor(details) {
    const key = details?.dataset?.filterDetails || '';
    return FILTER_LABELS[key] || details?.querySelector('summary span')?.textContent?.trim() || 'filter';
  }

  function searchPlaceholder(details) {
    const key = details?.dataset?.filterDetails || '';
    const label = labelFor(details);
    return ['regional', 'zone', 'outlet'].includes(key)
      ? `Search ${label} by code or name…`
      : `Search ${label}…`;
  }

  function rebuildSearchIndex(details) {
    details.querySelectorAll(OPTION_SELECTOR).forEach(option => {
      const input = option.querySelector('input');
      const label = option.querySelector('span')?.textContent || option.textContent || '';
      const value = input?.value || '';
      // Search against BOTH the hidden/raw filter value and the visible label.
      // This enables Outlet Code + Outlet Name, Regional ID + Name, Zone ID + Name.
      option.dataset.optionSearch = normalize(`${value} ${label}`);
    });
  }

  function ensureSearchMeta(details) {
    const menu = details.querySelector('.sidebar-filter-menu');
    const search = details.querySelector(SEARCH_SELECTOR);
    if (!menu || !search) return;

    let meta = menu.querySelector('.sidebar-filter-search-meta');
    if (!meta) {
      meta = document.createElement('div');
      meta.className = 'sidebar-filter-search-meta';
      meta.setAttribute('aria-live', 'polite');
      search.insertAdjacentElement('afterend', meta);
    }

    let noResults = details.querySelector('.sidebar-filter-no-results');
    const optionsWrap = details.querySelector('.sidebar-filter-options');
    if (!noResults && optionsWrap) {
      noResults = document.createElement('div');
      noResults.className = 'sidebar-filter-no-results';
      noResults.hidden = true;
      noResults.textContent = 'No matching options';
      optionsWrap.appendChild(noResults);
    }
  }

  function applySearch(details) {
    const search = details.querySelector(SEARCH_SELECTOR);
    if (!search) return;

    const query = normalize(search.value);
    const options = [...details.querySelectorAll(OPTION_SELECTOR)];
    let visible = 0;

    options.forEach(option => {
      const match = !query || normalize(option.dataset.optionSearch).includes(query);
      option.hidden = !match;
      if (match) visible += 1;
    });

    const meta = details.querySelector('.sidebar-filter-search-meta');
    if (meta) {
      meta.textContent = query
        ? `${visible} of ${options.length} option${options.length === 1 ? '' : 's'} shown`
        : `${options.length} option${options.length === 1 ? '' : 's'} available`;
    }

    const noResults = details.querySelector('.sidebar-filter-no-results');
    if (noResults) noResults.hidden = !query || visible > 0;
  }

  function enhanceFilter(details) {
    if (!(details instanceof HTMLElement) || !details.matches(FILTER_SELECTOR)) return;

    const search = details.querySelector(SEARCH_SELECTOR);
    if (!search) return;

    const placeholder = searchPlaceholder(details);
    search.placeholder = placeholder;
    search.setAttribute('aria-label', placeholder.replace('…', ''));
    search.setAttribute('autocomplete', 'off');
    search.setAttribute('autocapitalize', 'none');
    search.setAttribute('enterkeyhint', 'search');
    search.spellcheck = false;

    rebuildSearchIndex(details);
    ensureSearchMeta(details);
    applySearch(details);
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

  function openAndFocus(details, initialText = null) {
    if (!details) return;
    details.setAttribute('open', '');
    closeOtherFilters(details);
    enhanceFilter(details);

    requestAnimationFrame(() => {
      const search = details.querySelector(SEARCH_SELECTOR);
      if (!search) return;
      search.focus({ preventScroll: true });
      if (initialText !== null) {
        search.value = initialText;
        search.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        search.select();
      }
    });
  }

  // The main dashboard rebuilds the filter DOM after selections are applied.
  // Observe those redraws and safely re-attach search UX without touching data logic.
  let mutationQueued = false;
  const observer = new MutationObserver(() => {
    if (mutationQueued) return;
    mutationQueued = true;
    requestAnimationFrame(() => {
      mutationQueued = false;
      enhanceAll();
    });
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
  enhanceAll();

  // Opening any dashboard filter immediately activates its search field.
  document.addEventListener('toggle', event => {
    const details = event.target;
    if (!(details instanceof HTMLElement) || !details.matches(FILTER_SELECTOR) || !details.open) return;
    closeOtherFilters(details);
    enhanceFilter(details);
    requestAnimationFrame(() => details.querySelector(SEARCH_SELECTOR)?.focus({ preventScroll: true }));
  }, true);

  // Reapply our richer code+name search after the dashboard's own input handler.
  document.addEventListener('input', event => {
    const search = event.target.closest?.(SEARCH_SELECTOR);
    if (!search) return;
    const details = search.closest(FILTER_SELECTOR);
    if (!details) return;
    rebuildSearchIndex(details);
    requestAnimationFrame(() => applySearch(details));
  });

  // Clicking a filter summary opens it and makes search the next interaction.
  document.addEventListener('click', event => {
    const summary = event.target.closest?.(`${FILTER_SELECTOR} > summary`);
    if (!summary) return;
    const details = summary.parentElement;
    if (!details) return;
    // Native <details> toggling still happens; focus is handled in toggle listener.
    if (!details.open) closeOtherFilters(details);
  });

  // Keyboard UX:
  // - Start typing while a filter header is focused -> open filter and search.
  // - Ctrl/Cmd+F while search is focused stays in dashboard filter, not browser find.
  // - Escape clears query first; a second Escape closes the filter.
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
    openAndFocus(details, event.key);
  });
})();
