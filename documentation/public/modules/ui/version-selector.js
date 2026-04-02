/**
 * ui/version-selector.js
 * Custom styled version dropdown built from /data/versions.json.
 * The version badge itself becomes the trigger; clicking it reveals a
 * floating menu of available doc versions.
 */

let _loadDocs = null;
let _versions = null;
let _currentVersion = null;
let _selectedVersion = null;

const CHEVRON = '<svg width="8" height="5" viewBox="0 0 8 5" fill="none"><path d="M1 1l3 3 3-3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Register the loadDocs callback (called from boot.js).
 */
export function registerVersionLoadDocs(fn) { _loadDocs = fn; }

/**
 * Get the currently-selected version string (for use by search, etc.).
 */
export function getSelectedVersion() { return _selectedVersion || _currentVersion || null; }

/**
 * Get the full versions list.
 */
export function getVersions() { return _versions; }

/**
 * Fetch versions.json and the current version, then initialise the dropdown.
 * Returns the latest version string so loadDocs can use it on first boot.
 */
export async function initVersionSelector()
{
	const badge = document.getElementById('version-badge');
	if (!badge) return null;

	const _v = window.__v ? `?v=${window.__v}` : '';

	const [curRes, verRes] = await Promise.allSettled([
		fetch('/api/version').then(r => r.json()),
		fetch(`/data/versions.json${_v}`).then(r =>
		{
			if (!r.ok) throw new Error('no versions');
			return r.json();
		}),
	]);

	_currentVersion = curRes.status === 'fulfilled' ? curRes.value.version : null;
	_versions       = verRes.status === 'fulfilled' ? verRes.value : null;

	if (!_versions || !_versions.length)
	{
		if (_currentVersion) badge.textContent = 'v' + _currentVersion;
		return _currentVersion;
	}

	const latest = _versions.find(v => v.latest) || _versions[0];
	_selectedVersion = latest.version;

	/* Build the dropdown wrapper around the badge */
	const wrapper = document.createElement('div');
	wrapper.className = 'version-dropdown';
	wrapper.id = 'version-dropdown';
	badge.parentNode.insertBefore(wrapper, badge);
	wrapper.appendChild(badge);

	/* Turn badge into a button trigger */
	badge.setAttribute('role', 'button');
	badge.setAttribute('aria-expanded', 'false');
	badge.setAttribute('tabindex', '0');
	badge.innerHTML = `v${latest.version} ${CHEVRON}`;
	badge.classList.add('version-badge-trigger');

	/* Build the floating menu */
	const menu = document.createElement('div');
	menu.className = 'version-menu';
	menu.setAttribute('role', 'listbox');

	for (const entry of _versions)
	{
		const item = document.createElement('div');
		item.className = 'version-menu-item' + (entry.latest ? ' selected' : '');
		item.setAttribute('role', 'option');
		item.setAttribute('data-version', entry.version);
		item.textContent = entry.latest ? `v${entry.version} (latest)` : `v${entry.version}`;
		menu.appendChild(item);
	}
	wrapper.appendChild(menu);

	/* Toggle on click */
	badge.addEventListener('click', (e) =>
	{
		e.preventDefault();
		e.stopPropagation();
		const open = wrapper.classList.toggle('open');
		badge.setAttribute('aria-expanded', String(open));
	});

	badge.addEventListener('keydown', (e) =>
	{
		if (e.key === 'Enter' || e.key === ' ')
		{
			e.preventDefault();
			badge.click();
		}
	});

	/* Select a version */
	menu.addEventListener('click', async (e) =>
	{
		const item = e.target.closest('.version-menu-item');
		if (!item) return;

		const ver = item.dataset.version;
		_selectedVersion = ver;

		/* Update selected state */
		menu.querySelectorAll('.version-menu-item').forEach(el => el.classList.remove('selected'));
		item.classList.add('selected');

		/* Update badge text */
		const isLatest = ver === latest.version;
		badge.innerHTML = `v${ver}${isLatest ? '' : ' <span class="version-old-tag">old</span>'} ${CHEVRON}`;

		/* Sync the search version badge */
		const searchBadge = document.getElementById('search-version-indicator');
		if (searchBadge && searchBadge.classList.contains('version-badge-trigger'))
		{
			searchBadge.innerHTML = `v${ver}${isLatest ? '' : ' <span class="version-old-tag">old</span>'} ${CHEVRON}`;
		}
		const searchMenu = document.querySelector('.search-version-dropdown .version-menu');
		if (searchMenu)
		{
			searchMenu.querySelectorAll('.version-menu-item').forEach(i =>
			{
				i.classList.toggle('selected', i.dataset.version === ver);
			});
		}

		/* Close dropdown */
		wrapper.classList.remove('open');
		badge.setAttribute('aria-expanded', 'false');

		/* Reload docs from the chosen version */
		if (_loadDocs)
		{
			window._docsVersion = ver;
			await _loadDocs(ver);
		}
	});

	/* Close when clicking outside */
	document.addEventListener('click', (e) =>
	{
		if (!wrapper.contains(e.target))
		{
			wrapper.classList.remove('open');
			badge.setAttribute('aria-expanded', 'false');
		}
	});

	return latest.version;
}

/**
 * Build a version-switching dropdown on the search-version-indicator element.
 * Selecting a version here updates the global state and the main badge too.
 */
export function initSearchVersionBadge()
{
	const el = document.getElementById('search-version-indicator');
	if (!el || !_versions || !_versions.length) return;

	const latest = _versions.find(v => v.latest) || _versions[0];

	/* Wrap element in a dropdown container */
	const wrapper = document.createElement('div');
	wrapper.className = 'version-dropdown search-version-dropdown';
	el.parentNode.insertBefore(wrapper, el);
	wrapper.appendChild(el);

	/* Turn indicator into a trigger */
	el.setAttribute('role', 'button');
	el.setAttribute('aria-expanded', 'false');
	el.setAttribute('tabindex', '0');
	el.innerHTML = `v${_selectedVersion || latest.version} ${CHEVRON}`;
	el.classList.add('version-badge-trigger');

	/* Build menu */
	const menu = document.createElement('div');
	menu.className = 'version-menu';
	menu.setAttribute('role', 'listbox');

	for (const entry of _versions)
	{
		const item = document.createElement('div');
		item.className = 'version-menu-item' + (entry.version === (_selectedVersion || latest.version) ? ' selected' : '');
		item.setAttribute('role', 'option');
		item.setAttribute('data-version', entry.version);
		item.textContent = entry.latest ? `v${entry.version} (latest)` : `v${entry.version}`;
		menu.appendChild(item);
	}
	wrapper.appendChild(menu);

	/* Toggle */
	el.addEventListener('click', (e) =>
	{
		e.preventDefault();
		e.stopPropagation();
		const open = wrapper.classList.toggle('open');
		el.setAttribute('aria-expanded', String(open));
	});

	el.addEventListener('keydown', (e) =>
	{
		if (e.key === 'Enter' || e.key === ' ')
		{
			e.preventDefault();
			el.click();
		}
	});

	/* Escape inside the search-version dropdown: close dropdown, refocus input */
	wrapper.addEventListener('keydown', (e) =>
	{
		if (e.key === 'Escape' && wrapper.classList.contains('open'))
		{
			e.stopPropagation();
			wrapper.classList.remove('open');
			el.setAttribute('aria-expanded', 'false');
			const searchInput = document.getElementById('search-modal-input');
			if (searchInput) searchInput.focus();
		}
	});

	/* Select a version */
	menu.addEventListener('click', async (e) =>
	{
		const item = e.target.closest('.version-menu-item');
		if (!item) return;

		const ver = item.dataset.version;
		_selectedVersion = ver;

		/* Update selected state in this menu */
		menu.querySelectorAll('.version-menu-item').forEach(i => i.classList.remove('selected'));
		item.classList.add('selected');

		/* Update search badge text */
		const isLatest = ver === latest.version;
		el.innerHTML = `v${ver}${isLatest ? '' : ' <span class="version-old-tag">old</span>'} ${CHEVRON}`;

		/* Sync the main version badge */
		const mainBadge = document.getElementById('version-badge');
		if (mainBadge)
		{
			mainBadge.innerHTML = `v${ver}${isLatest ? '' : ' <span class="version-old-tag">old</span>'} ${CHEVRON}`;
		}
		const mainMenu = document.querySelector('#version-dropdown .version-menu');
		if (mainMenu)
		{
			mainMenu.querySelectorAll('.version-menu-item').forEach(i =>
			{
				i.classList.toggle('selected', i.dataset.version === ver);
			});
		}

		/* Close dropdown */
		wrapper.classList.remove('open');
		el.setAttribute('aria-expanded', 'false');

		/* Refocus search input so Escape closes the modal */
		const searchInput = document.getElementById('search-modal-input');
		if (searchInput) searchInput.focus();

		/* Reload docs */
		if (_loadDocs)
		{
			window._docsVersion = ver;
			await _loadDocs(ver);
		}
	});

	/* Close when clicking outside */
	document.addEventListener('click', (e) =>
	{
		if (!wrapper.contains(e.target))
		{
			wrapper.classList.remove('open');
			el.setAttribute('aria-expanded', 'false');
		}
	});
}
