const { HealthService, ServingStatus } = require('../../lib/grpc/health');

// =========================================================
// ServingStatus enum
// =========================================================

describe('ServingStatus', () =>
{
    it('should have correct numeric values', () =>
    {
        expect(ServingStatus.UNKNOWN).toBe(0);
        expect(ServingStatus.SERVING).toBe(1);
        expect(ServingStatus.NOT_SERVING).toBe(2);
        expect(ServingStatus.SERVICE_UNKNOWN).toBe(3);
    });
});

// =========================================================
// HealthService
// =========================================================

describe('HealthService', () =>
{
    let health;

    beforeEach(() =>
    {
        health = new HealthService();
    });

    // --- Constructor ---

    it('should start with overall status SERVING', () =>
    {
        expect(health.getStatus('')).toBe(ServingStatus.SERVING);
    });

    it('should return SERVICE_UNKNOWN for unregistered service', () =>
    {
        expect(health.getStatus('unknown.Service')).toBe(ServingStatus.SERVICE_UNKNOWN);
    });

    // --- setStatus ---

    it('should set and get status by service name', () =>
    {
        health.setStatus('my.Service', ServingStatus.SERVING);
        expect(health.getStatus('my.Service')).toBe(ServingStatus.SERVING);
    });

    it('should accept string status names', () =>
    {
        health.setStatus('my.Service', 'NOT_SERVING');
        expect(health.getStatus('my.Service')).toBe(ServingStatus.NOT_SERVING);
    });

    it('should throw for invalid status', () =>
    {
        expect(() => health.setStatus('test', 99)).toThrow('Invalid health status');
        expect(() => health.setStatus('test', 'INVALID')).toThrow('Invalid health status');
    });

    it('should update existing service status', () =>
    {
        health.setStatus('svc', ServingStatus.SERVING);
        health.setStatus('svc', ServingStatus.NOT_SERVING);
        expect(health.getStatus('svc')).toBe(ServingStatus.NOT_SERVING);
    });

    // --- setAllNotServing ---

    it('should set all services to NOT_SERVING', () =>
    {
        health.setStatus('svc-a', ServingStatus.SERVING);
        health.setStatus('svc-b', ServingStatus.SERVING);

        health.setAllNotServing();

        expect(health.getStatus('')).toBe(ServingStatus.NOT_SERVING);
        expect(health.getStatus('svc-a')).toBe(ServingStatus.NOT_SERVING);
        expect(health.getStatus('svc-b')).toBe(ServingStatus.NOT_SERVING);
    });

    // --- Watch subscribers ---

    it('should notify watchers on status change', () =>
    {
        const statuses = [];
        health._watch('my.Service', (s) => { statuses.push(s); });

        health.setStatus('my.Service', ServingStatus.SERVING);
        health.setStatus('my.Service', ServingStatus.NOT_SERVING);

        expect(statuses).toEqual([ServingStatus.SERVING, ServingStatus.NOT_SERVING]);
    });

    it('should not notify when status unchanged', () =>
    {
        health.setStatus('my.Service', ServingStatus.SERVING);

        const statuses = [];
        health._watch('my.Service', (s) => { statuses.push(s); });

        // Set same status again
        health.setStatus('my.Service', ServingStatus.SERVING);
        expect(statuses).toHaveLength(0);
    });

    it('should allow unsubscribing watcher', () =>
    {
        const statuses = [];
        const unsub = health._watch('my.Service', (s) => { statuses.push(s); });

        health.setStatus('my.Service', ServingStatus.SERVING);
        unsub();
        health.setStatus('my.Service', ServingStatus.NOT_SERVING);

        expect(statuses).toEqual([ServingStatus.SERVING]);
    });

    it('should handle multiple watchers on same service', () =>
    {
        const a = [];
        const b = [];
        health._watch('svc', (s) => a.push(s));
        health._watch('svc', (s) => b.push(s));

        health.setStatus('svc', ServingStatus.NOT_SERVING);

        expect(a).toEqual([ServingStatus.NOT_SERVING]);
        expect(b).toEqual([ServingStatus.NOT_SERVING]);
    });

    it('should clean up watcher set when last subscriber unsubscribes', () =>
    {
        const unsub = health._watch('svc', () => {});
        expect(health._watchers.has('svc')).toBe(true);
        unsub();
        expect(health._watchers.has('svc')).toBe(false);
    });

    // --- Check handler ---

    it('Check should return current status for registered service', () =>
    {
        health.setStatus('test', ServingStatus.SERVING);
        const result = health.Check({ request: { service: 'test' } });
        expect(result).toEqual({ status: ServingStatus.SERVING });
    });

    it('Check should return SERVICE_UNKNOWN for unregistered service', () =>
    {
        const result = health.Check({ request: { service: 'unknown' } });
        expect(result).toEqual({ status: ServingStatus.SERVICE_UNKNOWN });
    });

    it('Check should default to overall health when service is empty', () =>
    {
        const result = health.Check({ request: {} });
        expect(result).toEqual({ status: ServingStatus.SERVING });
    });

    it('Check should default to overall health when service is missing', () =>
    {
        const result = health.Check({ request: {} });
        expect(result.status).toBe(ServingStatus.SERVING);
    });

    // --- Watch handler ---

    it('Watch should send current status immediately', () =>
    {
        health.setStatus('svc', ServingStatus.SERVING);

        const written = [];
        const call = {
            request: { service: 'svc' },
            _ended: false,
            _cancelled: false,
            write(msg) { written.push(msg); },
            stream: { on() {} },
        };

        health.Watch(call);

        expect(written).toHaveLength(1);
        expect(written[0]).toEqual({ status: ServingStatus.SERVING });
    });

    it('Watch should push subsequent status changes', () =>
    {
        const written = [];
        const closeHandlers = [];
        const call = {
            request: { service: 'svc' },
            _ended: false,
            _cancelled: false,
            write(msg) { written.push(msg); },
            stream: { on(evt, fn) { if (evt === 'close') closeHandlers.push(fn); } },
        };

        health.Watch(call);
        health.setStatus('svc', ServingStatus.SERVING);
        health.setStatus('svc', ServingStatus.NOT_SERVING);

        expect(written).toHaveLength(3); // initial SERVICE_UNKNOWN + SERVING + NOT_SERVING
    });

    it('Watch should not write after stream ended', () =>
    {
        const written = [];
        const call = {
            request: { service: 'svc' },
            _ended: false,
            _cancelled: false,
            write(msg) { written.push(msg); },
            stream: { on() {} },
        };

        health.Watch(call);
        call._ended = true;
        health.setStatus('svc', ServingStatus.SERVING);

        // Only the initial write
        expect(written).toHaveLength(1);
    });

    // --- getSchema ---

    it('should return a valid schema', () =>
    {
        const schema = health.getSchema();
        expect(schema.package).toBe('grpc.health.v1');
        expect(schema.services.Health).toBeDefined();
        expect(schema.services.Health.methods.Check).toBeDefined();
        expect(schema.services.Health.methods.Watch).toBeDefined();
        expect(schema.services.Health.methods.Check.serverStreaming).toBe(false);
        expect(schema.services.Health.methods.Watch.serverStreaming).toBe(true);
        expect(schema.messages.HealthCheckRequest).toBeDefined();
        expect(schema.messages.HealthCheckResponse).toBeDefined();
    });

    // --- getHandlers ---

    it('should return bound handlers', () =>
    {
        const handlers = health.getHandlers();
        expect(typeof handlers.Check).toBe('function');
        expect(typeof handlers.Watch).toBe('function');
    });

    it('returned Check handler should be bound to instance', () =>
    {
        health.setStatus('bound-test', ServingStatus.SERVING);
        const handlers = health.getHandlers();
        const result = handlers.Check({ request: { service: 'bound-test' } });
        expect(result.status).toBe(ServingStatus.SERVING);
    });

    // --- Edge cases ---

    it('should handle empty string service name for overall health', () =>
    {
        health.setStatus('', ServingStatus.NOT_SERVING);
        expect(health.getStatus('')).toBe(ServingStatus.NOT_SERVING);
    });

    it('should handle many services', () =>
    {
        for (let i = 0; i < 100; i++)
        {
            health.setStatus(`service.${i}`, ServingStatus.SERVING);
        }
        for (let i = 0; i < 100; i++)
        {
            expect(health.getStatus(`service.${i}`)).toBe(ServingStatus.SERVING);
        }
    });

    it('should invalidate cache on status change', () =>
    {
        health.setStatus('cached', ServingStatus.SERVING);
        // Force cache population
        health._getResponseBytes(ServingStatus.SERVING);
        // Change status — cache should be invalidated (no error)
        health.setStatus('cached', ServingStatus.NOT_SERVING);
        expect(health.getStatus('cached')).toBe(ServingStatus.NOT_SERVING);
    });
});
