/**
 * Coverage tests for lib/errors.js — targets Phase 4 error constructors
 * (TenancyError, AuditError, PluginError, ProcedureError), HttpError edge
 * branches, and ORM error subclass property branches.
 */
const {
    HttpError,
    TenancyError,
    AuditError,
    PluginError,
    ProcedureError,
    ConnectionError,
    MigrationError,
    TransactionError,
    QueryError,
    AdapterError,
    CacheError,
    DatabaseError,
    createError,
    isHttpError,
} = require('../../lib/errors');

// =========================================================
// Phase 4 Error Classes — full property coverage
// =========================================================

describe('TenancyError', () =>
{
    it('creates with defaults', () =>
    {
        const err = new TenancyError();
        expect(err.statusCode).toBe(500);
        expect(err.code).toBe('TENANCY_ERROR');
        expect(err.message).toBe('Tenancy Error');
        expect(err).toBeInstanceOf(DatabaseError);
        expect(err).toBeInstanceOf(HttpError);
        expect(err).toBeInstanceOf(Error);
    });

    it('stores tenant and strategy from opts', () =>
    {
        const err = new TenancyError('Tenant not found', { tenant: 'acme', strategy: 'schema' });
        expect(err.message).toBe('Tenant not found');
        expect(err.tenant).toBe('acme');
        expect(err.strategy).toBe('schema');
    });

    it('handles opts without tenant/strategy', () =>
    {
        const err = new TenancyError('No tenant', {});
        expect(err.tenant).toBeUndefined();
        expect(err.strategy).toBeUndefined();
    });

    it('serializes via toJSON', () =>
    {
        const err = new TenancyError('fail', { tenant: 't1' });
        const json = err.toJSON();
        expect(json.error).toBe('fail');
        expect(json.code).toBe('TENANCY_ERROR');
        expect(json.statusCode).toBe(500);
    });

    it('isHttpError recognizes TenancyError', () =>
    {
        expect(isHttpError(new TenancyError())).toBe(true);
    });
});

describe('AuditError', () =>
{
    it('creates with defaults', () =>
    {
        const err = new AuditError();
        expect(err.statusCode).toBe(500);
        expect(err.code).toBe('AUDIT_ERROR');
        expect(err.message).toBe('Audit Error');
        expect(err).toBeInstanceOf(DatabaseError);
    });

    it('stores action and table from opts', () =>
    {
        const err = new AuditError('Audit log failed', { action: 'INSERT', table: 'users' });
        expect(err.message).toBe('Audit log failed');
        expect(err.action).toBe('INSERT');
        expect(err.table).toBe('users');
    });

    it('handles opts without action/table', () =>
    {
        const err = new AuditError('fail', {});
        expect(err.action).toBeUndefined();
        expect(err.table).toBeUndefined();
    });

    it('serializes via toJSON', () =>
    {
        const json = new AuditError('boom', { action: 'DELETE' }).toJSON();
        expect(json.code).toBe('AUDIT_ERROR');
    });
});

describe('PluginError', () =>
{
    it('creates with defaults', () =>
    {
        const err = new PluginError();
        expect(err.statusCode).toBe(500);
        expect(err.code).toBe('PLUGIN_ERROR');
        expect(err.message).toBe('Plugin Error');
        expect(err).toBeInstanceOf(HttpError);
    });

    it('stores plugin and phase from opts', () =>
    {
        const err = new PluginError('Plugin crashed', { plugin: 'auth-plugin', phase: 'boot' });
        expect(err.message).toBe('Plugin crashed');
        expect(err.plugin).toBe('auth-plugin');
        expect(err.phase).toBe('boot');
    });

    it('handles opts without plugin/phase', () =>
    {
        const err = new PluginError('fail', {});
        expect(err.plugin).toBeUndefined();
        expect(err.phase).toBeUndefined();
    });

    it('serializes via toJSON', () =>
    {
        const json = new PluginError('boom', { plugin: 'p1' }).toJSON();
        expect(json.code).toBe('PLUGIN_ERROR');
    });
});

describe('ProcedureError', () =>
{
    it('creates with defaults', () =>
    {
        const err = new ProcedureError();
        expect(err.statusCode).toBe(500);
        expect(err.code).toBe('PROCEDURE_ERROR');
        expect(err.message).toBe('Procedure Error');
        expect(err).toBeInstanceOf(DatabaseError);
    });

    it('stores procedure and operation from opts', () =>
    {
        const err = new ProcedureError('Proc failed', { procedure: 'sp_update', operation: 'execute' });
        expect(err.message).toBe('Proc failed');
        expect(err.procedure).toBe('sp_update');
        expect(err.operation).toBe('execute');
    });

    it('handles opts without procedure/operation', () =>
    {
        const err = new ProcedureError('fail', {});
        expect(err.procedure).toBeUndefined();
        expect(err.operation).toBeUndefined();
    });

    it('serializes via toJSON', () =>
    {
        const json = new ProcedureError('boom', { procedure: 'fn1' }).toJSON();
        expect(json.code).toBe('PROCEDURE_ERROR');
    });
});

// =========================================================
// HttpError edge branches
// =========================================================

describe('HttpError edge branches', () =>
{
    it('_defaultCode handles unmapped status code', () =>
    {
        const err = new HttpError(499, 'Client closed');
        // Should fallback to 'ERROR' since 499 is not in STATUS_TEXT
        expect(err.code).toBe('ERROR');
    });

    it('toJSON without details does not include details key', () =>
    {
        const err = new HttpError(500);
        const json = err.toJSON();
        expect('details' in json).toBe(false);
    });

    it('toJSON with undefined details still omits key', () =>
    {
        const err = new HttpError(500, 'err', {});
        const json = err.toJSON();
        expect('details' in json).toBe(false);
    });

    it('_defaultCode strips leading/trailing underscores', () =>
    {
        // 418 is "I'm a Teapot" → should not have leading/trailing underscores
        const err = new HttpError(418);
        expect(err.code).toBe('I_M_A_TEAPOT');
        expect(err.code.startsWith('_')).toBe(false);
        expect(err.code.endsWith('_')).toBe(false);
    });

    it('constructor with explicit undefined details', () =>
    {
        const err = new HttpError(400, 'Bad', { details: undefined });
        expect(err.details).toBeUndefined();
        const json = err.toJSON();
        expect('details' in json).toBe(false);
    });
});

// =========================================================
// ORM Error subclass property branches — all opts
// =========================================================

describe('ConnectionError property branches', () =>
{
    it('stores all optional properties', () =>
    {
        const err = new ConnectionError('fail', { adapter: 'pg', attempt: 3, maxRetries: 5, host: 'db.local', port: 5432 });
        expect(err.adapter).toBe('pg');
        expect(err.attempt).toBe(3);
        expect(err.maxRetries).toBe(5);
        expect(err.host).toBe('db.local');
        expect(err.port).toBe(5432);
    });

    it('omits undefined optional properties', () =>
    {
        const err = new ConnectionError('fail', {});
        expect(err.attempt).toBeUndefined();
        expect(err.maxRetries).toBeUndefined();
        expect(err.host).toBeUndefined();
        expect(err.port).toBeUndefined();
    });

    it('stores attempt=0 (falsy but defined)', () =>
    {
        const err = new ConnectionError('fail', { attempt: 0, maxRetries: 0 });
        expect(err.attempt).toBe(0);
        expect(err.maxRetries).toBe(0);
    });
});

describe('MigrationError property branches', () =>
{
    it('stores all optional properties', () =>
    {
        const err = new MigrationError('fail', { migration: 'create_users', direction: 'up', batch: 3 });
        expect(err.migration).toBe('create_users');
        expect(err.direction).toBe('up');
        expect(err.batch).toBe(3);
    });

    it('stores batch=0 (falsy but defined)', () =>
    {
        const err = new MigrationError('fail', { batch: 0 });
        expect(err.batch).toBe(0);
    });

    it('omits undefined optional properties', () =>
    {
        const err = new MigrationError('fail', {});
        expect(err.migration).toBeUndefined();
        expect(err.direction).toBeUndefined();
        expect(err.batch).toBeUndefined();
    });
});

describe('TransactionError property branches', () =>
{
    it('stores phase', () =>
    {
        const err = new TransactionError('fail', { phase: 'commit' });
        expect(err.phase).toBe('commit');
    });

    it('omits phase when not provided', () =>
    {
        const err = new TransactionError('fail', {});
        expect(err.phase).toBeUndefined();
    });
});

describe('QueryError property branches', () =>
{
    it('stores all optional properties', () =>
    {
        const err = new QueryError('fail', { sql: 'SELECT 1', params: [1, 2], table: 'users' });
        expect(err.sql).toBe('SELECT 1');
        expect(err.params).toEqual([1, 2]);
        expect(err.table).toBe('users');
    });

    it('omits undefined optional properties', () =>
    {
        const err = new QueryError('fail', {});
        expect(err.sql).toBeUndefined();
        expect(err.params).toBeUndefined();
        expect(err.table).toBeUndefined();
    });
});

describe('AdapterError property branches', () =>
{
    it('stores operation', () =>
    {
        const err = new AdapterError('fail', { operation: 'connect', adapter: 'mysql' });
        expect(err.operation).toBe('connect');
        expect(err.adapter).toBe('mysql');
    });

    it('omits operation when not provided', () =>
    {
        const err = new AdapterError('fail', {});
        expect(err.operation).toBeUndefined();
    });
});

describe('CacheError property branches', () =>
{
    it('stores operation and key', () =>
    {
        const err = new CacheError('fail', { operation: 'get', key: 'user:42' });
        expect(err.operation).toBe('get');
        expect(err.key).toBe('user:42');
    });

    it('omits optional properties when not provided', () =>
    {
        const err = new CacheError('fail', {});
        expect(err.operation).toBeUndefined();
        expect(err.key).toBeUndefined();
    });
});

// =========================================================
// createError — unmapped status falls back to HttpError
// =========================================================

describe('createError edge cases', () =>
{
    it('returns HttpError for completely unknown status code', () =>
    {
        const err = createError(999, 'Unknown');
        expect(err).toBeInstanceOf(HttpError);
        expect(err.statusCode).toBe(999);
    });

    it('passes opts through for unmapped codes', () =>
    {
        const err = createError(499, 'Gone', { code: 'CUSTOM', details: { x: 1 } });
        expect(err.code).toBe('CUSTOM');
        expect(err.details).toEqual({ x: 1 });
    });
});

// =========================================================
// DatabaseError property branches
// =========================================================

describe('DatabaseError property branches', () =>
{
    it('omits query when not provided', () =>
    {
        const err = new DatabaseError('fail', {});
        expect(err.query).toBeUndefined();
    });

    it('omits adapter when not provided', () =>
    {
        const err = new DatabaseError('fail', {});
        expect(err.adapter).toBeUndefined();
    });
});
