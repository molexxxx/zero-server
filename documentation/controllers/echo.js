/** Echo JSON body back as { received: ... } */
const echoBody = (req, res) => res.json({ received: req.body });

exports.echoJson       = echoBody;
exports.echo           = echoBody;
exports.echoUrlencoded = echoBody;

exports.echoText = (req, res) => res.text(req.body || '');

exports.echoRaw = (req, res) =>
{
    const b = req.body || Buffer.alloc(0);
    res.json({ length: b.length, preview: b.slice(0, 64).toString('hex') });
};