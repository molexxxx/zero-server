/**
 * @module helmet
 * @description Security headers middleware.
 *              Sets common security-related HTTP response headers to help
 *              protect against well-known web vulnerabilities (XSS, clickjacking,
 *              MIME sniffing, etc.).
 *
 *              Inspired by the `helmet` npm package but zero-dependency.
 */

/**
 * Create a security headers middleware.
 *
 * @param {object}  [opts] - Configuration options.
 * @param {object|false}  [opts.contentSecurityPolicy]      - CSP directive object or `false` to disable.
 * @param {boolean}       [opts.crossOriginEmbedderPolicy=false]  - Set COEP header.
 * @param {string|false}  [opts.crossOriginOpenerPolicy='same-origin'] - COOP value.
 * @param {string|false}  [opts.crossOriginResourcePolicy='same-origin'] - CORP value.
 * @param {boolean}       [opts.dnsPrefetchControl=true]    - Set X-DNS-Prefetch-Control: off.
 * @param {string|false}  [opts.frameguard='deny']          - X-Frame-Options value ('deny' | 'sameorigin').
 * @param {boolean}       [opts.hidePoweredBy=true]         - Remove X-Powered-By header.
 * @param {boolean|number}[opts.hsts=true]                  - Set Strict-Transport-Security.
 * @param {number}        [opts.hstsMaxAge=15552000]        - HSTS max-age in seconds (default ~180 days).
 * @param {boolean}       [opts.hstsIncludeSubDomains=true] - HSTS includeSubDomains directive.
 * @param {boolean}       [opts.hstsPreload=false]          - HSTS preload directive.
 * @param {boolean}       [opts.ieNoOpen=true]              - Set X-Download-Options: noopen.
 * @param {boolean}       [opts.noSniff=true]               - Set X-Content-Type-Options: nosniff.
 * @param {string|false}  [opts.permittedCrossDomainPolicies='none'] - X-Permitted-Cross-Domain-Policies.
 * @param {string|false}  [opts.referrerPolicy='no-referrer'] - Referrer-Policy value.
 * @param {boolean}       [opts.xssFilter=false]            - Set X-XSS-Protection (legacy, off by default).
 * @returns {Function} Middleware `(req, res, next) => void`.
 *
 * @example
 *   app.use(helmet());
 *   app.use(helmet({ frameguard: 'sameorigin', hsts: false }));
 *   app.use(helmet({
 *       contentSecurityPolicy: {
 *           directives: {
 *               defaultSrc: ["'self'"],
 *               scriptSrc: ["'self'", "'unsafe-inline'"],
 *               styleSrc: ["'self'", "'unsafe-inline'"],
 *               imgSrc: ["'self'", "data:", "https:"],
 *           }
 *       }
 *   }));
 */
function helmet(opts = {})
{
    return (req, res, next) =>
    {
        const raw = res.raw || res;

        // -- Content-Security-Policy --------------------
        if (opts.contentSecurityPolicy !== false)
        {
            const csp = opts.contentSecurityPolicy || {};
            const directives = csp.directives || {
                defaultSrc: ["'self'"],
                baseUri: ["'self'"],
                fontSrc: ["'self'", 'https:', 'data:'],
                formAction: ["'self'"],
                frameAncestors: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                objectSrc: ["'none'"],
                scriptSrc: ["'self'"],
                scriptSrcAttr: ["'none'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                upgradeInsecureRequests: [],
            };

            const cspString = Object.entries(directives)
                .map(([key, values]) =>
                {
                    const directive = key.replace(/([A-Z])/g, '-$1').toLowerCase();
                    if (Array.isArray(values) && values.length === 0) return directive;
                    return `${directive} ${Array.isArray(values) ? values.join(' ') : values}`;
                })
                .join('; ');

            if (cspString)
            {
                try { raw.setHeader('Content-Security-Policy', cspString); } catch (e) { }
            }
        }

        // -- Cross-Origin-Embedder-Policy ---------------
        if (opts.crossOriginEmbedderPolicy)
        {
            try { raw.setHeader('Cross-Origin-Embedder-Policy', 'require-corp'); } catch (e) { }
        }

        // -- Cross-Origin-Opener-Policy -----------------
        if (opts.crossOriginOpenerPolicy !== false)
        {
            const coop = opts.crossOriginOpenerPolicy || 'same-origin';
            try { raw.setHeader('Cross-Origin-Opener-Policy', coop); } catch (e) { }
        }

        // -- Cross-Origin-Resource-Policy ---------------
        if (opts.crossOriginResourcePolicy !== false)
        {
            const corp = opts.crossOriginResourcePolicy || 'same-origin';
            try { raw.setHeader('Cross-Origin-Resource-Policy', corp); } catch (e) { }
        }

        // -- DNS Prefetch Control -----------------------
        if (opts.dnsPrefetchControl !== false)
        {
            try { raw.setHeader('X-DNS-Prefetch-Control', 'off'); } catch (e) { }
        }

        // -- Frameguard (X-Frame-Options) ---------------
        if (opts.frameguard !== false)
        {
            const frame = (opts.frameguard || 'deny').toUpperCase();
            try { raw.setHeader('X-Frame-Options', frame); } catch (e) { }
        }

        // -- Hide X-Powered-By -------------------------
        if (opts.hidePoweredBy !== false)
        {
            try { raw.removeHeader('X-Powered-By'); } catch (e) { }
        }

        // -- HSTS ---------------------------------------
        if (opts.hsts !== false)
        {
            const maxAge = opts.hstsMaxAge || 15552000;
            let hstsValue = `max-age=${maxAge}`;
            if (opts.hstsIncludeSubDomains !== false) hstsValue += '; includeSubDomains';
            if (opts.hstsPreload) hstsValue += '; preload';
            try { raw.setHeader('Strict-Transport-Security', hstsValue); } catch (e) { }
        }

        // -- IE No Open --------------------------------
        if (opts.ieNoOpen !== false)
        {
            try { raw.setHeader('X-Download-Options', 'noopen'); } catch (e) { }
        }

        // -- No Sniff -----------------------------------
        if (opts.noSniff !== false)
        {
            try { raw.setHeader('X-Content-Type-Options', 'nosniff'); } catch (e) { }
        }

        // -- Permitted Cross Domain Policies ------------
        if (opts.permittedCrossDomainPolicies !== false)
        {
            const pcdp = opts.permittedCrossDomainPolicies || 'none';
            try { raw.setHeader('X-Permitted-Cross-Domain-Policies', pcdp); } catch (e) { }
        }

        // -- Referrer Policy ----------------------------
        if (opts.referrerPolicy !== false)
        {
            const rp = opts.referrerPolicy || 'no-referrer';
            try { raw.setHeader('Referrer-Policy', rp); } catch (e) { }
        }

        // -- XSS Filter (legacy) -----------------------
        if (opts.xssFilter)
        {
            try { raw.setHeader('X-XSS-Protection', '1; mode=block'); } catch (e) { }
        }
        else
        {
            // Modern best practice: disable legacy XSS auditor
            try { raw.setHeader('X-XSS-Protection', '0'); } catch (e) { }
        }

        next();
    };
}

module.exports = helmet;
