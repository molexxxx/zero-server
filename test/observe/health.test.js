const {
    healthCheck,
    createHealthHandlers,
    memoryCheck,
    eventLoopCheck,
    diskSpaceCheck,
} = require('../../lib/observe/health');

// ── helpers ──────────────────────────────────────────────────────

function mockReqRes(appOverrides = {})
{
    const req = { app: appOverrides };
    let statusCode = 200;
    let body = null;
    const res = {
        status: (code) => { statusCode = code; return res; },
        json: (data) => { body = data; },
    };
    return { req, res, getStatus: () => statusCode, getBody: () => body };
}

// ── memoryCheck ──────────────────────────────────────────────────

describe('memoryCheck', () =>
{
    it('returns healthy by default', () =>
    {
        const check = memoryCheck();
        const result = check();
        expect(result.healthy).toBe(true);
        expect(result.details.heapUsed).toBeGreaterThan(0);
        expect(result.details.rss).toBeGreaterThan(0);
    });

    it('reports unhealthy when heap percent is exceeded', () =>
    {
        // Setting maxHeapUsedPercent to 0 should always fail
        const check = memoryCheck({ maxHeapUsedPercent: 0 });
        const result = check();
        expect(result.healthy).toBe(false);
    });

    it('reports unhealthy when rss exceeds max', () =>
    {
        // 1 byte max should always fail
        const check = memoryCheck({ maxRssBytes: 1 });
        const result = check();
        expect(result.healthy).toBe(false);
    });

    it('includes detail fields', () =>
    {
        const check = memoryCheck();
        const result = check();
        expect(typeof result.details.heapPercent).toBe('number');
        expect(typeof result.details.heapTotal).toBe('number');
        expect(typeof result.details.external).toBe('number');
    });
});

// ── eventLoopCheck ───────────────────────────────────────────────

describe('eventLoopCheck', () =>
{
    it('returns healthy with default maxLagMs', () =>
    {
        const check = eventLoopCheck();
        const result = check();
        expect(result.healthy).toBe(true);
        expect(typeof result.details.lagMs).toBe('number');
        expect(result.details.maxLagMs).toBe(500);
        check._cleanup();
    });

    it('accepts custom maxLagMs', () =>
    {
        const check = eventLoopCheck({ maxLagMs: 1000 });
        const result = check();
        expect(result.details.maxLagMs).toBe(1000);
        check._cleanup();
    });

    it('exposes _cleanup for testing', () =>
    {
        const check = eventLoopCheck();
        expect(typeof check._cleanup).toBe('function');
        check._cleanup();
    });
});

// ── diskSpaceCheck ───────────────────────────────────────────────

describe('diskSpaceCheck', () =>
{
    it('returns healthy with default threshold', () =>
    {
        const check = diskSpaceCheck();
        const result = check();
        expect(result.healthy).toBe(true);
        expect(result.details.freeMemory).toBeGreaterThan(0);
    });

    it('reports unhealthy with impossibly high threshold', () =>
    {
        const check = diskSpaceCheck({ minFreeBytes: Number.MAX_SAFE_INTEGER });
        const result = check();
        expect(result.healthy).toBe(false);
    });

    it('includes detail fields', () =>
    {
        const check = diskSpaceCheck();
        const result = check();
        expect(typeof result.details.totalMemory).toBe('number');
        expect(typeof result.details.minRequired).toBe('number');
    });
});

// ── healthCheck handler ──────────────────────────────────────────

describe('healthCheck', () =>
{
    it('returns 200 healthy with no checks', async () =>
    {
        const handler = healthCheck();
        const { req, res, getStatus, getBody } = mockReqRes();
        await handler(req, res);

        expect(getStatus()).toBe(200);
        const body = getBody();
        expect(body.status).toBe('healthy');
        expect(typeof body.uptime).toBe('number');
        expect(body.timestamp).toBeTruthy();
        expect(body.duration).toBeGreaterThanOrEqual(0);
    });

    it('returns 200 when all checks pass', async () =>
    {
        const handler = healthCheck({
            checks: {
                db: () => ({ healthy: true }),
                cache: () => true,
            },
        });
        const { req, res, getStatus, getBody } = mockReqRes();
        await handler(req, res);

        expect(getStatus()).toBe(200);
        expect(getBody().status).toBe('healthy');
        expect(getBody().checks.db.healthy).toBe(true);
        expect(getBody().checks.cache.healthy).toBe(true);
    });

    it('returns 503 when any check fails', async () =>
    {
        const handler = healthCheck({
            checks: {
                ok: () => ({ healthy: true }),
                fail: () => ({ healthy: false, details: { reason: 'down' } }),
            },
        });
        const { req, res, getStatus, getBody } = mockReqRes();
        await handler(req, res);

        expect(getStatus()).toBe(503);
        expect(getBody().status).toBe('unhealthy');
        expect(getBody().checks.fail.healthy).toBe(false);
        expect(getBody().checks.fail.details.reason).toBe('down');
    });

    it('handles async checks', async () =>
    {
        const handler = healthCheck({
            checks: {
                async_check: async () =>
                {
                    await new Promise(r => setTimeout(r, 5));
                    return { healthy: true, details: { latency: 5 } };
                },
            },
        });
        const { req, res, getStatus, getBody } = mockReqRes();
        await handler(req, res);

        expect(getStatus()).toBe(200);
        expect(getBody().checks.async_check.healthy).toBe(true);
    });

    it('times out slow checks', async () =>
    {
        const handler = healthCheck({
            timeout: 10,
            checks: {
                slow: () => new Promise(r => setTimeout(() => r({ healthy: true }), 200)),
            },
        });
        const { req, res, getStatus, getBody } = mockReqRes();
        await handler(req, res);

        expect(getStatus()).toBe(503);
        expect(getBody().checks.slow.healthy).toBe(false);
        expect(getBody().checks.slow.error).toContain('timed out');
    });

    it('catches check errors and reports unhealthy', async () =>
    {
        const handler = healthCheck({
            checks: {
                exploder: () => { throw new Error('boom'); },
            },
        });
        const { req, res, getStatus, getBody } = mockReqRes();
        await handler(req, res);

        expect(getStatus()).toBe(503);
        expect(getBody().checks.exploder.healthy).toBe(false);
        expect(getBody().checks.exploder.error).toBe('boom');
    });

    it('reports check duration', async () =>
    {
        const handler = healthCheck({
            checks: {
                fast: () => ({ healthy: true }),
            },
        });
        const { req, res, getBody } = mockReqRes();
        await handler(req, res);

        expect(typeof getBody().checks.fast.duration).toBe('number');
    });

    it('returns 503 during shutdown lifecycle', async () =>
    {
        const handler = healthCheck();
        const { req, res, getStatus, getBody } = mockReqRes({ lifecycleState: 'draining' });
        await handler(req, res);

        expect(getStatus()).toBe(503);
        expect(getBody().status).toBe('unavailable');
        expect(getBody().reason).toBe('shutdown');
        expect(getBody().lifecycleState).toBe('draining');
    });

    it('returns 200 when lifecycleState is running', async () =>
    {
        const handler = healthCheck();
        const { req, res, getStatus } = mockReqRes({ lifecycleState: 'running' });
        await handler(req, res);
        expect(getStatus()).toBe(200);
    });

    it('calls onFailure callback when checks fail', async () =>
    {
        let failResults = null;
        const handler = healthCheck({
            checks: { fail: () => false },
            onFailure: (results) => { failResults = results; },
        });
        const { req, res } = mockReqRes();
        await handler(req, res);

        expect(failResults).not.toBeNull();
        expect(failResults.fail.healthy).toBe(false);
    });

    it('does not call onFailure when all checks pass', async () =>
    {
        let called = false;
        const handler = healthCheck({
            checks: { ok: () => ({ healthy: true }) },
            onFailure: () => { called = true; },
        });
        const { req, res } = mockReqRes();
        await handler(req, res);
        expect(called).toBe(false);
    });

    it('onFailure errors do not break response', async () =>
    {
        const handler = healthCheck({
            checks: { fail: () => false },
            onFailure: () => { throw new Error('callback fail'); },
        });
        const { req, res, getStatus, getBody } = mockReqRes();
        await handler(req, res);
        expect(getStatus()).toBe(503);
        expect(getBody().status).toBe('unhealthy');
    });

    it('verbose=false hides check details', async () =>
    {
        const handler = healthCheck({
            verbose: false,
            checks: {
                db: () => ({ healthy: true, details: { latency: 2 } }),
            },
        });
        const { req, res, getBody } = mockReqRes();
        await handler(req, res);
        expect(getBody().checks.db.details).toBeUndefined();
    });

    it('handles boolean check result', async () =>
    {
        const handler = healthCheck({
            checks: { simple: () => true },
        });
        const { req, res, getBody } = mockReqRes();
        await handler(req, res);
        expect(getBody().checks.simple.healthy).toBe(true);
    });

    it('handles non-object non-boolean result as healthy', async () =>
    {
        const handler = healthCheck({
            checks: { weird: () => 'ok' },
        });
        const { req, res, getBody } = mockReqRes();
        await handler(req, res);
        expect(getBody().checks.weird.healthy).toBe(true);
    });
});

// ── createHealthHandlers ─────────────────────────────────────────

describe('createHealthHandlers', () =>
{
    it('returns health and ready handlers', () =>
    {
        const { health, ready } = createHealthHandlers();
        expect(typeof health).toBe('function');
        expect(typeof ready).toBe('function');
    });

    it('includes memory check in liveness when enabled', async () =>
    {
        const { health } = createHealthHandlers({ includeMemory: true });
        const { req, res, getBody } = mockReqRes();
        await health(req, res);
        expect(getBody().checks.memory).toBeDefined();
        expect(getBody().checks.memory.healthy).toBe(true);
    });

    it('includes event loop check when enabled', async () =>
    {
        const { health } = createHealthHandlers({ includeEventLoop: true });
        const { req, res, getBody } = mockReqRes();
        await health(req, res);
        expect(getBody().checks.eventLoop).toBeDefined();

        // Cleanup the interval
        // Note: Can't directly cleanup from here without access to the check internals
    });

    it('includes custom checks in readiness only', async () =>
    {
        const { health, ready } = createHealthHandlers({
            checks: { database: () => ({ healthy: true }) },
        });

        const h = mockReqRes();
        await health(h.req, h.res);
        expect(h.getBody().checks?.database).toBeUndefined();

        const r = mockReqRes();
        await ready(r.req, r.res);
        expect(r.getBody().checks.database.healthy).toBe(true);
    });

    it('passes timeout to both handlers', async () =>
    {
        const { health } = createHealthHandlers({ timeout: 1000 });
        const { req, res, getStatus } = mockReqRes();
        await health(req, res);
        expect(getStatus()).toBe(200);
    });

    it('passes onFailure to ready handler', async () =>
    {
        let called = false;
        const { ready } = createHealthHandlers({
            checks: { fail: () => false },
            onFailure: () => { called = true; },
        });
        const { req, res } = mockReqRes();
        await ready(req, res);
        expect(called).toBe(true);
    });
});
