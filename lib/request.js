const { StringDecoder } = require('string_decoder');
const querystring = require('querystring');

class Request
{
    constructor(req)
    {
        this.raw = req;
        this.method = req.method;
        this.url = req.url;
        this.headers = req.headers;
        this.query = this._parseQuery();
        this.params = {};
        this.body = null;
        this._parsed = false;
    }

    _parseQuery()
    {
        const idx = this.url.indexOf('?');
        if (idx === -1) return {};
        return querystring.parse(this.url.slice(idx + 1));
    }

    async parseBody()
    {
        if (this._parsed) return this.body;
        const ct = this.headers['content-type'] || '';
        const decoder = new StringDecoder('utf8');
        let buf = '';
        for await (const chunk of this.raw) buf += decoder.write(chunk || '');
        buf += decoder.end();
        if (!buf) { this.body = null; this._parsed = true; return this.body; }
        if (ct.includes('application/json'))
        {
            try { this.body = JSON.parse(buf); } catch (e) { this.body = buf; }
        } else if (ct.includes('application/x-www-form-urlencoded'))
        {
            this.body = querystring.parse(buf);
        } else
        {
            this.body = buf;
        }
        this._parsed = true;
        return this.body;
    }
}

module.exports = Request;
