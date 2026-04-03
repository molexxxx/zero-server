/**
 * @module auth/authorize
 * @description Authorization helpers — role-based access control (RBAC),
 *              permission-based access, and policy classes.
 *
 *              Works with any authentication middleware that sets `req.user`.
 *
 * @example
 *   const { authorize, can } = require('zero-http');
 *
 *   // Role-based: only admins and editors
 *   app.put('/posts/:id', authorize('admin', 'editor'), (req, res) => {
 *       res.json({ updated: true });
 *   });
 *
 *   // Permission-based
 *   app.delete('/posts/:id', can('posts:delete'), (req, res) => {
 *       res.json({ deleted: true });
 *   });
 *
 *   // Policy class
 *   class PostPolicy extends Policy {
 *       update(user, post) { return user.id === post.authorId || user.role === 'admin'; }
 *       delete(user, post) { return user.role === 'admin'; }
 *   }
 *   app.delete('/posts/:id', gate(new PostPolicy(), 'delete', async (req) => {
 *       return await db.query('SELECT * FROM posts WHERE id = ?', [req.params.id]);
 *   }), (req, res) => {
 *       res.json({ deleted: true });
 *   });
 */
const log = require('../debug')('zero:auth');

// -- Role-Based Access Control ------------------------------------

/**
 * Role-based authorization middleware.
 * Checks `req.user.role` or `req.user.roles` against allowed roles.
 *
 * Returns 401 if `req.user` is missing (not authenticated).
 * Returns 403 if the user's role is not in the allowed list.
 *
 * @param {...string} roles - Allowed roles.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.get('/admin', authorize('admin'), (req, res) => {
 *       res.json({ message: 'Welcome, admin!' });
 *   });
 *
 * @example
 *   // Multiple roles
 *   app.put('/posts/:id', authorize('admin', 'editor'), (req, res) => {
 *       res.json({ updated: true });
 *   });
 */
function authorize(...roles)
{
    const allowed = new Set(roles.flat());

    return function authorizeMiddleware(req, res, next)
    {
        if (!req.user)
        {
            return res.status(401).json({
                error: 'Authentication required',
                code: 'NOT_AUTHENTICATED',
                statusCode: 401,
            });
        }

        const userRoles = _extractRoles(req.user);
        const hasRole = userRoles.some(r => allowed.has(r));

        if (!hasRole)
        {
            log.debug('access denied: user roles [%s] not in [%s]', userRoles.join(', '), [...allowed].join(', '));
            return res.status(403).json({
                error: 'Insufficient permissions',
                code: 'FORBIDDEN',
                statusCode: 403,
            });
        }

        log.debug('authorized: role=%s', userRoles.find(r => allowed.has(r)));
        next();
    };
}

// -- Permission-Based Access Control --------------------------------

/**
 * Permission-based authorization middleware.
 * Checks `req.user.permissions` (array or Set) for the required permission(s).
 *
 * Permission strings follow a `resource:action` convention:
 *   - `'posts:write'` — write access to posts
 *   - `'users:delete'` — delete users
 *   - `'*'` — superuser wildcard
 *
 * @param {...string} permissions - Required permissions (ALL must be present unless `opts.any` is true).
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   // Require specific permission
 *   app.post('/posts', can('posts:write'), (req, res) => {
 *       res.status(201).json(req.body);
 *   });
 *
 * @example
 *   // Require ALL permissions
 *   app.put('/users/:id', can('users:read', 'users:write'), (req, res) => {
 *       res.json({ updated: true });
 *   });
 *
 * @example
 *   // Require ANY permission (use canAny)
 *   app.get('/dashboard', canAny('admin:read', 'reports:read'), (req, res) => {
 *       res.json({ dashboard: true });
 *   });
 */
function can(...permissions)
{
    return _permissionMiddleware(permissions.flat(), false);
}

/**
 * Like `can()`, but passes if the user has ANY of the listed permissions.
 *
 * @param {...string} permissions - Permissions to check (any one is sufficient).
 * @returns {Function} Middleware.
 *
 * @example
 *   app.get('/reports', canAny('reports:read', 'admin:read'), (req, res) => {
 *       res.json({ reports: [] });
 *   });
 */
function canAny(...permissions)
{
    return _permissionMiddleware(permissions.flat(), true);
}

/** @private */
function _permissionMiddleware(required, anyMode)
{
    return function permissionMiddleware(req, res, next)
    {
        if (!req.user)
        {
            return res.status(401).json({
                error: 'Authentication required',
                code: 'NOT_AUTHENTICATED',
                statusCode: 401,
            });
        }

        const userPerms = _extractPermissions(req.user);

        // Wildcard superuser
        if (userPerms.has('*'))
        {
            log.debug('wildcard permission granted');
            return next();
        }

        const check = anyMode
            ? required.some(p => userPerms.has(p))
            : required.every(p => userPerms.has(p));

        if (!check)
        {
            log.debug('permission denied: required [%s] (mode=%s)', required.join(', '), anyMode ? 'any' : 'all');
            return res.status(403).json({
                error: 'Insufficient permissions',
                code: 'FORBIDDEN',
                statusCode: 403,
            });
        }

        next();
    };
}

// -- Policy Classes -----------------------------------------------

/**
 * Base policy class for resource-level authorization.
 * Subclass and define methods matching action names.
 * Each method receives `(user, resource)` and returns `boolean`.
 *
 * @example
 *   class PostPolicy extends Policy {
 *       view()                 { return true; }          // anyone can view
 *       update(user, post)     { return user.id === post.authorId; }
 *       delete(user, post)     { return user.role === 'admin'; }
 *       publish(user, post)    { return ['admin', 'editor'].includes(user.role); }
 *   }
 */
class Policy
{
    /**
     * Check if an action is allowed.
     * Falls through to the action method if defined, otherwise denies.
     *
     * @param {string} action - The action name (method name).
     * @param {object} user - The authenticated user.
     * @param {object} [resource] - The resource being accessed.
     * @returns {boolean|Promise<boolean>}
     */
    check(action, user, resource)
    {
        if (typeof this.before === 'function')
        {
            const beforeResult = this.before(user, action, resource);
            if (beforeResult === true) return true;
            if (beforeResult === false) return false;
            // undefined = continue to action method
        }

        if (typeof this[action] !== 'function') return false;
        return this[action](user, resource);
    }
}

/**
 * Policy gate middleware.
 * Runs a policy check against a resource loaded from the request.
 *
 * @param {Policy} policy - Policy instance.
 * @param {string} action - Action name to check.
 * @param {Function} [getResource] - `async (req) => resource` loader. If omitted, passes `null`.
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   const postPolicy = new PostPolicy();
 *
 *   // With resource loader
 *   app.put('/posts/:id', gate(postPolicy, 'update', async (req) => {
 *       return await Post.findById(req.params.id);
 *   }), (req, res) => {
 *       res.json({ updated: req.resource });
 *   });
 *
 *   // Without resource (for create/list actions)
 *   app.post('/posts', gate(postPolicy, 'create'), (req, res) => {
 *       res.status(201).json(req.body);
 *   });
 */
function gate(policy, action, getResource)
{
    return async function gateMiddleware(req, res, next)
    {
        if (!req.user)
        {
            return res.status(401).json({
                error: 'Authentication required',
                code: 'NOT_AUTHENTICATED',
                statusCode: 401,
            });
        }

        let resource = null;
        if (typeof getResource === 'function')
        {
            resource = await getResource(req);
        }

        const allowed = await policy.check(action, req.user, resource);
        if (!allowed)
        {
            log.debug('policy denied: action=%s', action);
            return res.status(403).json({
                error: 'Action not allowed',
                code: 'POLICY_DENIED',
                statusCode: 403,
            });
        }

        // Attach resource if loaded — saves a redundant DB query in the handler
        if (resource && !req.resource) req.resource = resource;
        next();
    };
}

// -- req.user helpers (mixed in by middleware barrel) ----------------

/**
 * Attach convenience authorization methods to `req.user`.
 * Call this middleware after JWT/session middleware.
 *
 * Adds:
 *   - `req.user.is(...roles)` — check roles
 *   - `req.user.can(...perms)` — check permissions
 *
 * @returns {Function} Middleware.
 *
 * @example
 *   app.use(jwt({ secret }));
 *   app.use(attachUserHelpers());
 *
 *   app.get('/dashboard', (req, res) => {
 *       if (req.user.is('admin')) {
 *           // admin view
 *       }
 *       if (req.user.can('reports:export')) {
 *           // show export button
 *       }
 *   });
 */
function attachUserHelpers()
{
    return function userHelpersMiddleware(req, res, next)
    {
        if (!req.user) return next();

        if (!req.user.is)
        {
            req.user.is = (...roles) =>
            {
                const userRoles = _extractRoles(req.user);
                return roles.flat().some(r => userRoles.includes(r));
            };
        }

        if (!req.user.can)
        {
            req.user.can = (...perms) =>
            {
                const userPerms = _extractPermissions(req.user);
                if (userPerms.has('*')) return true;
                return perms.flat().every(p => userPerms.has(p));
            };
        }

        next();
    };
}

// -- Internal Helpers -----------------------------------------------

/**
 * Normalise user roles from various formats.
 * Supports `user.role` (string), `user.roles` (array), and `user.role` (array).
 *
 * @param {object} user
 * @returns {string[]}
 * @private
 */
function _extractRoles(user)
{
    if (!user) return [];
    if (Array.isArray(user.roles)) return user.roles;
    if (Array.isArray(user.role)) return user.role;
    if (typeof user.role === 'string') return [user.role];
    return [];
}

/**
 * Normalise user permissions from various formats.
 * Supports `user.permissions` (array or Set), `user.scopes` (array).
 *
 * @param {object} user
 * @returns {Set<string>}
 * @private
 */
function _extractPermissions(user)
{
    if (!user) return new Set();
    if (user.permissions instanceof Set) return user.permissions;
    if (Array.isArray(user.permissions)) return new Set(user.permissions);
    if (Array.isArray(user.scopes)) return new Set(user.scopes);
    return new Set();
}

module.exports = {
    authorize,
    can,
    canAny,
    Policy,
    gate,
    attachUserHelpers,
};
