exports.echoJson = (req, res) => res.json({ received: req.body });
exports.echo = (req, res) => res.json({ received: req.body });
exports.echoUrlencoded = (req, res) => res.json({ received: req.body });
exports.echoText = (req, res) => res.text(req.body || '');
exports.echoRaw = (req, res) =>
{
    const b = req.body || Buffer.alloc(0);
    res.json({ length: b.length, preview: b.slice(0, 64).toString('hex') });
};