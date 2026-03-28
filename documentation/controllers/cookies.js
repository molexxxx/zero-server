exports.list = (req, res) =>
{
    res.json({
        cookies: req.cookies || {},
        signedCookies: req.signedCookies || {},
    });
};

exports.set = (req, res) =>
{
    const { name, value, options } = req.body || {};
    if (!name || typeof name !== 'string')
        return res.status(400).json({ error: 'name is required' });

    const val = value != null ? value : '';
    const opts = {};
    if (options)
    {
        if (options.maxAge != null) opts.maxAge = Number(options.maxAge);
        if (options.httpOnly != null) opts.httpOnly = Boolean(options.httpOnly);
        if (options.secure != null) opts.secure = Boolean(options.secure);
        if (options.sameSite) opts.sameSite = String(options.sameSite);
        if (options.path) opts.path = String(options.path);
        if (options.signed) opts.signed = true;
    }
    res.cookie(name, typeof val === 'object' ? val : String(val), opts);
    res.json({ set: name, value: val, options: opts });
};

exports.clear = (req, res) =>
{
    res.clearCookie(req.params.name);
    res.json({ cleared: req.params.name });
};
