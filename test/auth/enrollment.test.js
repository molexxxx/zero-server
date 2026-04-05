const { generateSecret, generateTOTP, verifyTOTP, generateBackupCodes } = require('../../lib/auth/twoFactor');

// We test enrollment via direct require to get the factory
const enrollmentModule = require('../../lib/auth/enrollment');
const enrollment = enrollmentModule.enrollment || enrollmentModule;

// -- Mock helpers ---

function mockSession()
{
    const data = {};
    return {
        _data: data,
        get(k) { return data[k] ?? null; },
        set(k, v) { data[k] = v; },
    };
}

function mockReq(overrides = {})
{
    return {
        user: { id: 'test-user', email: 'test@example.com' },
        body: {},
        session: mockSession(),
        headers: {},
        ...overrides,
    };
}

function mockRes()
{
    const res = {
        statusCode: 200,
        _headers: {},
        _body: null,
        headersSent: false,
        setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
        getHeader(k) { return this._headers[k.toLowerCase()]; },
        end(body) { this._body = body; this.headersSent = true; },
    };
    res.raw = res;
    return res;
}

function parseBody(res) { return JSON.parse(res._body); }

// =========================================================
// enrollment() factory
// =========================================================

describe('enrollment() factory', () =>
{
    it('should throw without saveSecret', () =>
    {
        expect(() => enrollment({ removeSecret: () => {} })).toThrow('saveSecret');
    });

    it('should throw without removeSecret', () =>
    {
        expect(() => enrollment({ saveSecret: () => {} })).toThrow('removeSecret');
    });

    it('should return start, verify, complete, disable functions', () =>
    {
        const flow = enrollment({ saveSecret: () => {}, removeSecret: () => {} });
        expect(typeof flow.start).toBe('function');
        expect(typeof flow.verify).toBe('function');
        expect(typeof flow.complete).toBe('function');
        expect(typeof flow.disable).toBe('function');
    });
});

// =========================================================
// start() middleware
// =========================================================

describe('enrollment.start()', () =>
{
    const flow = enrollment({ saveSecret: () => {}, removeSecret: () => {} });

    it('should return 500 if no session middleware', async () =>
    {
        const mw = flow.start();
        const req = mockReq({ session: null });
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(500);
        expect(parseBody(res).error).toContain('Session middleware');
    });

    it('should return secret, uri, and backupCodes', async () =>
    {
        const mw = flow.start();
        const req = mockReq();
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(200);
        const body = parseBody(res);
        expect(body.secret).toBeDefined();
        expect(body.uri).toContain('otpauth://totp/');
        expect(body.backupCodes).toBeDefined();
        expect(body.expiresIn).toBeGreaterThan(0);
    });

    it('should store pending enrollment in session', async () =>
    {
        const mw = flow.start();
        const req = mockReq();
        const res = mockRes();
        await mw(req, res);
        const pending = req.session.get('_2faEnrollment');
        expect(pending).toBeDefined();
        expect(pending.secret).toBeDefined();
        expect(pending.backupHashes).toBeInstanceOf(Array);
        expect(pending.createdAt).toBeGreaterThan(0);
    });

    it('should return 409 if isEnabled returns true', async () =>
    {
        const flow2 = enrollment({
            saveSecret: () => {},
            removeSecret: () => {},
            isEnabled: () => true,
        });
        const mw = flow2.start();
        const req = mockReq();
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(409);
        expect(parseBody(res).error).toContain('already enabled');
    });
});

// =========================================================
// verify() middleware
// =========================================================

describe('enrollment.verify()', () =>
{
    const flow = enrollment({ saveSecret: () => {}, removeSecret: () => {} });

    it('should return 400 if no pending enrollment', async () =>
    {
        const mw = flow.verify();
        const req = mockReq();
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(400);
        expect(parseBody(res).error).toContain('No pending enrollment');
    });

    it('should return 410 if enrollment expired', async () =>
    {
        const mw = flow.verify();
        const req = mockReq();
        req.session.set('_2faEnrollment', {
            secret: 'JBSWY3DPEHPK3PXP',
            backupHashes: [],
            createdAt: Date.now() - 20 * 60 * 1000, // 20 minutes ago — expired
        });
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(410);
    });

    it('should return 400 for missing code', async () =>
    {
        const mw = flow.verify();
        const req = mockReq();
        req.session.set('_2faEnrollment', {
            secret: 'JBSWY3DPEHPK3PXP',
            backupHashes: [],
            createdAt: Date.now(),
        });
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(400);
        expect(parseBody(res).error).toContain('Missing');
    });

    it('should return 401 for invalid code', async () =>
    {
        const mw = flow.verify();
        const secretObj = generateSecret();
        const req = mockReq({ body: { code: '000000' } });
        req.session.set('_2faEnrollment', {
            secret: secretObj.base32,
            backupHashes: [],
            createdAt: Date.now(),
        });
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(401);
    });

    it('should verify valid code and mark as verified', async () =>
    {
        const mw = flow.verify();
        const secretObj = generateSecret();
        const time = Math.floor(Date.now() / 1000);
        const code = generateTOTP(secretObj.base32, { time });

        const req = mockReq({ body: { code } });
        req.session.set('_2faEnrollment', {
            secret: secretObj.base32,
            backupHashes: [],
            createdAt: Date.now(),
        });
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(200);
        expect(parseBody(res).verified).toBe(true);
        expect(req.session.get('_2faEnrollment').verified).toBe(true);
    });
});

// =========================================================
// complete() middleware
// =========================================================

describe('enrollment.complete()', () =>
{
    it('should return 400 if no pending enrollment', async () =>
    {
        const flow = enrollment({ saveSecret: () => {}, removeSecret: () => {} });
        const mw = flow.complete();
        const req = mockReq();
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(400);
    });

    it('should return 400 if not yet verified', async () =>
    {
        const flow = enrollment({ saveSecret: () => {}, removeSecret: () => {} });
        const mw = flow.complete();
        const req = mockReq();
        req.session.set('_2faEnrollment', {
            secret: 'ABC',
            backupHashes: [],
            createdAt: Date.now(),
            verified: false,
        });
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(400);
        expect(parseBody(res).error).toContain('not yet verified');
    });

    it('should return 410 if expired after verify', async () =>
    {
        const flow = enrollment({ saveSecret: () => {}, removeSecret: () => {} });
        const mw = flow.complete();
        const req = mockReq();
        req.session.set('_2faEnrollment', {
            secret: 'ABC',
            backupHashes: ['hash1'],
            createdAt: Date.now() - 20 * 60 * 1000,
            verified: true,
        });
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(410);
    });

    it('should call saveSecret and clear session on success', async () =>
    {
        let savedSecret = null;
        let savedHashes = null;
        const flow = enrollment({
            saveSecret: (_req, secret, hashes) => { savedSecret = secret; savedHashes = hashes; },
            removeSecret: () => {},
        });
        const mw = flow.complete();
        const req = mockReq();
        req.session.set('_2faEnrollment', {
            secret: 'MY_SECRET',
            backupHashes: ['h1', 'h2'],
            createdAt: Date.now(),
            verified: true,
        });
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(200);
        expect(parseBody(res).enabled).toBe(true);
        expect(savedSecret).toBe('MY_SECRET');
        expect(savedHashes).toEqual(['h1', 'h2']);
        expect(req.session.get('_2faEnrollment')).toBeNull();
        expect(req.session.get('twoFactorVerified')).toBe(true);
    });

    it('should return 500 if saveSecret throws', async () =>
    {
        const flow = enrollment({
            saveSecret: () => { throw new Error('db error'); },
            removeSecret: () => {},
        });
        const mw = flow.complete();
        const req = mockReq();
        req.session.set('_2faEnrollment', {
            secret: 'X',
            backupHashes: [],
            createdAt: Date.now(),
            verified: true,
        });
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(500);
    });
});

// =========================================================
// disable() middleware
// =========================================================

describe('enrollment.disable()', () =>
{
    it('should call removeSecret on success', async () =>
    {
        let removed = false;
        const flow = enrollment({
            saveSecret: () => {},
            removeSecret: () => { removed = true; },
        });
        const mw = flow.disable();
        const req = mockReq();
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(200);
        expect(removed).toBe(true);
    });

    it('should return 403 if confirm returns false', async () =>
    {
        const flow = enrollment({
            saveSecret: () => {},
            removeSecret: () => {},
        });
        const mw = flow.disable({ confirm: () => false });
        const req = mockReq();
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(403);
    });

    it('should proceed if confirm returns true', async () =>
    {
        let removed = false;
        const flow = enrollment({
            saveSecret: () => {},
            removeSecret: () => { removed = true; },
        });
        const mw = flow.disable({ confirm: () => true });
        const req = mockReq();
        const res = mockRes();
        await mw(req, res);
        expect(res.statusCode).toBe(200);
        expect(removed).toBe(true);
    });
});

// =========================================================
// Full enrollment flow (start → verify → complete)
// =========================================================

describe('Full enrollment flow', () =>
{
    it('start → verify → complete happy path', async () =>
    {
        let savedSecret = null;
        const flow = enrollment({
            saveSecret: (_req, secret) => { savedSecret = secret; },
            removeSecret: () => {},
        });

        const session = mockSession();

        // Step 1: start
        const startReq = mockReq({ session });
        const startRes = mockRes();
        await flow.start()(startReq, startRes);
        expect(startRes.statusCode).toBe(200);
        const startBody = parseBody(startRes);
        const enrollSecret = startBody.secret;

        // Step 2: verify with a valid code
        const code = generateTOTP(enrollSecret);
        const verifyReq = mockReq({ session, body: { code } });
        const verifyRes = mockRes();
        await flow.verify()(verifyReq, verifyRes);
        expect(verifyRes.statusCode).toBe(200);

        // Step 3: complete
        const completeReq = mockReq({ session });
        const completeRes = mockRes();
        await flow.complete()(completeReq, completeRes);
        expect(completeRes.statusCode).toBe(200);
        expect(savedSecret).toBe(enrollSecret);
    });

    it('should reject complete without verify', async () =>
    {
        const flow = enrollment({
            saveSecret: () => {},
            removeSecret: () => {},
        });

        const session = mockSession();

        // start
        await flow.start()(mockReq({ session }), mockRes());

        // skip verify, go straight to complete
        const completeReq = mockReq({ session });
        const completeRes = mockRes();
        await flow.complete()(completeReq, completeRes);
        expect(completeRes.statusCode).toBe(400);
        expect(parseBody(completeRes).error).toContain('not yet verified');
    });
});
