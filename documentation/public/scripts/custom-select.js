/**
 * custom-select.js
 * Replaces every native <select> with a styled dropdown.
 * The native element stays in the DOM (hidden) so .value, change events,
 * and form submission keep working with zero changes to existing JS.
 */

const ARROW_SVG = '<svg class="cs-arrow" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function initCustomSelects()
{
    const selects = document.querySelectorAll('select');
    selects.forEach(wrapSelect);

    // Close all dropdowns when clicking outside
    document.addEventListener('click', (e) =>
    {
        if (!e.target.closest('.custom-select'))
        {
            document.querySelectorAll('.custom-select.open').forEach(el => el.classList.remove('open'));
        }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) =>
    {
        if (e.key === 'Escape')
        {
            document.querySelectorAll('.custom-select.open').forEach(el => el.classList.remove('open'));
        }
    });
}

function wrapSelect(native)
{
    // Build wrapper
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';

    // Build trigger button
    const trigger = document.createElement('div');
    trigger.className = 'cs-trigger';
    trigger.setAttribute('tabindex', '0');
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    // Build dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'cs-dropdown';
    dropdown.setAttribute('role', 'listbox');

    // Populate options
    function buildOptions()
    {
        dropdown.innerHTML = '';
        const options = native.querySelectorAll('option');
        options.forEach((opt) =>
        {
            const item = document.createElement('div');
            item.className = 'cs-option' + (opt.selected ? ' selected' : '');
            item.textContent = opt.textContent;
            item.dataset.value = opt.value;
            item.setAttribute('role', 'option');
            item.addEventListener('click', (e) =>
            {
                e.stopPropagation();
                selectOption(native, wrapper, opt.value);
            });
            dropdown.appendChild(item);
        });
    }

    buildOptions();

    // Set initial label
    const selected = native.options[native.selectedIndex];
    trigger.innerHTML = (selected ? selected.textContent : '') + ' ' + ARROW_SVG;

    // Insert into DOM
    native.parentNode.insertBefore(wrapper, native);
    wrapper.appendChild(trigger);
    wrapper.appendChild(dropdown);
    wrapper.appendChild(native);
    native.classList.add('cs-hidden');

    // If select is inside a <label>, intercept label click to open dropdown
    const parentLabel = wrapper.closest('label');
    if (parentLabel)
    {
        parentLabel.addEventListener('click', (e) =>
        {
            if (e.target === parentLabel || e.target.nodeType === 3)
            {
                e.preventDefault();
                trigger.click();
            }
        });
    }

    // Toggle dropdown
    trigger.addEventListener('click', (e) =>
    {
        e.stopPropagation();
        // Close other open selects
        document.querySelectorAll('.custom-select.open').forEach(el =>
        {
            if (el !== wrapper) el.classList.remove('open');
        });
        const isOpen = wrapper.classList.toggle('open');
        trigger.setAttribute('aria-expanded', isOpen);

        // Scroll selected into view
        if (isOpen)
        {
            const sel = dropdown.querySelector('.cs-option.selected');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        }
    });

    // Keyboard navigation
    trigger.addEventListener('keydown', (e) =>
    {
        const isOpen = wrapper.classList.contains('open');

        if (e.key === 'Enter' || e.key === ' ')
        {
            e.preventDefault();
            if (!isOpen)
            {
                wrapper.classList.add('open');
                trigger.setAttribute('aria-expanded', 'true');
            }
            return;
        }

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp')
        {
            e.preventDefault();
            const opts = Array.from(native.options);
            let idx = native.selectedIndex;
            idx += e.key === 'ArrowDown' ? 1 : -1;
            idx = Math.max(0, Math.min(idx, opts.length - 1));
            selectOption(native, wrapper, opts[idx].value);
        }
    });

    // If native select changes programmatically, sync UI
    const observer = new MutationObserver(() =>
    {
        buildOptions();
        syncTriggerLabel(native, trigger);
    });
    observer.observe(native, { childList: true, subtree: true, attributes: true });
}

function selectOption(native, wrapper, value)
{
    native.value = value;
    native.dispatchEvent(new Event('change', { bubbles: true }));

    const trigger = wrapper.querySelector('.cs-trigger');
    const dropdown = wrapper.querySelector('.cs-dropdown');

    // Update selected state
    dropdown.querySelectorAll('.cs-option').forEach(o =>
    {
        o.classList.toggle('selected', o.dataset.value === value);
    });

    syncTriggerLabel(native, trigger);
    wrapper.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
}

function syncTriggerLabel(native, trigger)
{
    const selected = native.options[native.selectedIndex];
    trigger.innerHTML = (selected ? selected.textContent : '') + ' ' + ARROW_SVG;
}

// Auto-init when DOM is ready
if (document.readyState === 'loading')
{
    document.addEventListener('DOMContentLoaded', initCustomSelects);
} else
{
    initCustomSelects();
}
