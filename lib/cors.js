function cors(options = {})
{
    const allowOrigin = (options.hasOwnProperty('origin')) ? options.origin : '*';
    const allowMethods = (options.methods || 'GET,POST,PUT,DELETE,OPTIONS');
    const allowHeaders = (options.allowedHeaders || 'Content-Type,Authorization');

    function matchOrigin(reqOrigin)
    {
        if (!allowOrigin) return null; // origin explicitly disabled
        if (typeof allowOrigin === 'string') return allowOrigin === '*' ? '*' : allowOrigin;
        if (Array.isArray(allowOrigin))
        {
            if (!reqOrigin) return null;
            for (const o of allowOrigin)
            {
                if (!o) continue;
                if (o === reqOrigin) return reqOrigin;
                // allow suffix match with leading dot (e.g. .example.com)
                if (o[0] === '.' && reqOrigin.endsWith(o)) return reqOrigin;
            }
            return null;
        }
        return null;
    }

    return (req, res, next) =>
    {
        const reqOrigin = req.headers && (req.headers.origin || req.headers.Origin);
        const originValue = matchOrigin(reqOrigin);

        if (originValue)
        {
            res.set('Access-Control-Allow-Origin', originValue);
            // allow credentials when matching specific origin
            if (options.credentials) res.set('Access-Control-Allow-Credentials', 'true');
        }

        if (allowMethods) res.set('Access-Control-Allow-Methods', allowMethods);
        if (allowHeaders) res.set('Access-Control-Allow-Headers', allowHeaders);

        if (req.method === 'OPTIONS') return res.status(204).send();
        next();
    };
}

module.exports = cors;
