/**
 * ui/select.js
 * Replaces every native <select> with a styled dropdown.
 * The native element stays in the DOM so .value and change events keep working.
 */

const ARROW_SVG = '<svg class="cs-arrow" viewBox="0 0 10 6" fill="none"><path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function wrapSelect(native)
{
    const wrapper = document.createElement('div');
    wrapper.className = 'custom-select';

    const trigger = document.createElement('div');
    trigger.className = 'cs-trigger';
    trigger.setAttribute('tabindex', '0');
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const dropdown = document.createElement('div');
    dropdown.className = 'cs-dropdown';
    dropdown.setAttribute('role', 'listbox');

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

    const selected = native.options[native.selectedIndex];
    trigger.innerHTML = (selected ? selected.textContent : '') + ' ' + ARROW_SVG;

    native.parentNode.insertBefore(wrapper, native);
    wrapper.appendChild(trigger);
    wrapper.appendChild(dropdown);
    wrapper.appendChild(native);
    native.classList.add('cs-hidden');

    native.addEventListener('change', () =>
    {
        dropdown.querySelectorAll('.cs-option').forEach(o =>
        {
            o.classList.toggle('selected', o.dataset.value === native.value);
        });
        syncTriggerLabel(native, trigger);
    });

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

    trigger.addEventListener('click', (e) =>
    {
        e.stopPropagation();
        document.querySelectorAll('.custom-select.open').forEach(el =>
        {
            if (el !== wrapper) el.classList.remove('open');
        });
        const isOpen = wrapper.classList.toggle('open');
        trigger.setAttribute('aria-expanded', isOpen);
        if (isOpen)
        {
            const sel = dropdown.querySelector('.cs-option.selected');
            if (sel) sel.scrollIntoView({ block: 'nearest' });
        }
    });

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

export function initCustomSelects()
{
    const selects = document.querySelectorAll('select');
    selects.forEach(wrapSelect);

    document.addEventListener('click', (e) =>
    {
        if (!e.target.closest('.custom-select'))
        {
            document.querySelectorAll('.custom-select.open').forEach(el => el.classList.remove('open'));
        }
    });

    document.addEventListener('keydown', (e) =>
    {
        if (e.key === 'Escape')
        {
            document.querySelectorAll('.custom-select.open').forEach(el => el.classList.remove('open'));
        }
    });
}
