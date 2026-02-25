class Response {
  constructor(res) {
    this.raw = res;
    this._status = 200;
    this._headers = { 'Content-Type': 'application/json' };
    this._sent = false;
  }

  status(code) { this._status = code; return this; }

  set(name, value) { this._headers[name] = value; return this; }

  send(body) {
    if (this._sent) return;
    const res = this.raw;
    Object.entries(this._headers).forEach(([k,v]) => res.setHeader(k, v));
    res.statusCode = this._status;
    if (body === undefined || body === null) { res.end(); this._sent = true; return; }
    if (Buffer.isBuffer(body) || typeof body === 'string') {
      res.end(body);
    } else {
      res.end(JSON.stringify(body));
    }
    this._sent = true;
  }

  json(obj) { this.set('Content-Type', 'application/json'); return this.send(obj); }

  text(str) { this.set('Content-Type', 'text/plain'); return this.send(String(str)); }
}

module.exports = Response;
