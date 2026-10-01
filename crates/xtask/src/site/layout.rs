//! The page shell: everything around an article.
//!
//! One header and footer for every page, and for a documentation page the three-column
//! frame around it: the site navigation on the left, the article, and the page's own table
//! of contents on the right, with the previous and next page under the article. Everything
//! between the header and the footer sits in one `#page` element, which `site.js` swaps
//! when a reader follows a link, so a page changes without a reload; every link in the
//! shell starts at the base path so a swapped page never carries a path from another depth.
//! The base path is a setting (`DEFAULT_BASE`, `cargo xtask site --base <path>`), because a
//! GitHub Pages project site is served under its repository's name rather than at `/`. Every
//! page is still a complete document with its own title, description, canonical URL, and
//! Open Graph card, so a crawler or a reader without scripts sees the same thing.
//!
//! Hand-built strings rather than a template engine, like every other renderer in this
//! crate: there are two layouts, and the typing keeps a broken shell a compile error rather
//! than a page.

use super::highlight::escape;
use super::markdown::Heading;
use super::nav::Nav;
use super::{Kind, Page};

/// The repository, for the edit links.
const REPO: &str = "https://github.com/molexxxx/zero-server";

/// The host the site is served from, for the canonical URL and the card each page carries.
pub(crate) const HOST: &str = "https://molexxxx.github.io";

/// The base path of the site on that host: a GitHub Pages project site is served under the
/// repository's name. `cargo xtask site --base <path>` renders for another one, `/` included.
pub(crate) const DEFAULT_BASE: &str = "/zero-server/";

/// What every page's shell needs beyond the page itself.
pub struct Chrome<'a> {
    /// The workspace version the footer names.
    pub version: &'a str,
    /// The navigation the sidebar renders.
    pub nav: &'a Nav,
    /// The stamp of the stylesheets and scripts, which names each of them in a page.
    pub stamp: &'a str,
    /// The base path every link in the shell starts with, with both slashes (`/zero-server/`).
    pub base: &'a str,
}

/// The prefix that reaches the site root from a page (`../` for `docs/index.html`), for
/// the pages that must resolve on their own wherever they are opened.
pub fn root_of(url: &str) -> String {
    "../".repeat(url.matches('/').count())
}

/// The public address of a page: the host, the base path, and the page, with the front page
/// at the base path itself.
///
/// # Arguments
///
/// * `base` - the base path, with both slashes.
/// * `url` - the page, site-relative.
///
/// # Returns
///
/// The absolute URL.
pub fn canonical(base: &str, url: &str) -> String {
    if url == "index.html" {
        format!("{HOST}{base}")
    } else {
        format!("{HOST}{base}{url}")
    }
}

/// Whether a base path is well formed: it starts and ends with a slash and holds no empty
/// segment, so a site-relative URL appended to it is one path.
///
/// # Arguments
///
/// * `base` - the path as given.
///
/// # Returns
///
/// `true` for `/` and for `/zero-server/`, `false` for `zero-server`, `/zero-server` or
/// `//`.
pub fn valid_base(base: &str) -> bool {
    base.starts_with('/') && base.ends_with('/') && !base.contains("//")
}

// The site's address as a page shows it: the host and the base path without the scheme and
// the trailing slash (`molexxxx.github.io/zero-server`).
fn shown(base: &str) -> String {
    format!(
        "{}{}",
        HOST.trim_start_matches("https://"),
        base.trim_end_matches('/')
    )
}

/// A documentation page as a complete HTML document.
///
/// # Arguments
///
/// * `chrome` - the version and navigation the shell carries.
/// * `page` - the rendered article and what the frame around it shows.
///
/// # Returns
///
/// The document, from `<!doctype html>` to `</html>`.
pub fn document(chrome: &Chrome, page: &Page) -> String {
    let (previous, next) = chrome.nav.neighbors(&page.url);

    let full = if page.title == "zero-server" {
        "zero-server documentation".to_owned()
    } else {
        format!("{} - zero-server", page.title)
    };
    let mut out = head(
        &Head {
            title: &full,
            description: &page.description,
            url: &page.url,
            kind: "article",
        },
        chrome.stamp,
        chrome.base,
    );
    out.push_str("<body>\n");
    out.push_str("<a class=\"skip\" href=\"#content\">Skip to content</a>\n");
    out.push_str(&header(chrome.version, &page.url, chrome.base));
    // A page carrying the block diagram opens out: the diagram needs more width than a
    // reading column, so the sheet widens and the table of contents stands down, the way a
    // datasheet prints its block diagram on a foldout.
    let foldout = page.body.contains("class=\"bd\"");
    out.push_str(&format!(
        "<div id=\"page\">\n<div class=\"docs{}\">\n<aside class=\"side\" id=\"side\">\n",
        if foldout { " docs-foldout" } else { "" }
    ));
    out.push_str(&chrome.nav.sidebar(&page.url, chrome.base));
    out.push_str("</aside>\n<main class=\"content\" id=\"content\">\n");
    out.push_str(match page.kind {
        Kind::Guide => "<article class=\"article article-guide\">\n",
        Kind::Article => "<article class=\"article\">\n",
    });
    out.push_str(&page.body);
    out.push_str("</article>\n");
    out.push_str(&pager(previous, next, chrome.base));
    out.push_str(&format!(
        "<p class=\"edit\"><a href=\"{REPO}/edit/main/{}\">Edit this page on GitHub</a></p>\n",
        escape(&page.source)
    ));
    out.push_str("</main>\n");
    if !foldout {
        out.push_str(&toc(&page.toc));
    }
    out.push_str("</div>\n</div>\n");
    out.push_str(&footer(chrome.version, chrome.base));
    out.push_str(&format!(
        "<script src=\"{}js/site.js?v={}\" defer></script>\n</body>\n</html>\n",
        chrome.base, chrome.stamp
    ));
    out
}

/// The front page as a complete document: the shared header and footer around the body
/// `home.rs` renders, with the front page's own stylesheet and the scripts its consoles
/// and wall of cards need.
///
/// # Arguments
///
/// * `chrome` - the version and navigation the shell carries.
/// * `body` - the `<main>` element, rendered by the front page.
///
/// # Returns
///
/// The complete document.
pub fn home(chrome: &Chrome, body: &str) -> String {
    let base = chrome.base;
    let stamp = chrome.stamp;
    let mut out = head(
        &Head {
            title: "zero-server",
            description: "One memory-safe Rust web server core with bindings for TypeScript, Python, and C#, held to the standards it implements.",
            url: "index.html",
            kind: "website",
        },
        stamp,
        base,
    );
    out = out.replace(
        &format!("<link rel=\"stylesheet\" href=\"{base}site.css?v={stamp}\">\n"),
        &format!(
            "<link rel=\"stylesheet\" href=\"{base}site.css?v={stamp}\">\n<link rel=\"stylesheet\" href=\"{base}home.css?v={stamp}\">\n"
        ),
    );
    out.push_str("<body class=\"is-home\">\n");
    out.push_str("<a class=\"skip\" href=\"#content\">Skip to content</a>\n");
    out.push_str(&header(chrome.version, "index.html", base));
    out.push_str("<div id=\"page\">\n");
    out.push_str(&format!(
        "<nav class=\"side home-menu\" id=\"side\" aria-label=\"Site\">\n\
         <div class=\"side-nav\">\n\
         <ul>\n\
         <li><a href=\"{base}docs/index.html\">Docs</a></li>\n\
         <li><a href=\"{base}docs/install.html\">Install</a></li>\n\
         <li><a href=\"{base}docs/examples.html\">Examples</a></li>\n\
         <li><a href=\"{base}docs/about/standards.html\">Standards</a></li>\n\
         <li><a href=\"{base}docs/reference/index.html\">API reference</a></li>\n\
         </ul>\n\
         <details class=\"side-group\" open><summary>Project</summary><ul>\n\
         <li><a href=\"{REPO}\">Source on GitHub</a></li>\n\
         <li><a href=\"{base}docs/community.html\">Contribute</a></li>\n\
         <li><a href=\"{REPO}/issues/new?template=bug.yml\">Report a bug</a></li>\n\
         <li><a href=\"{REPO}/issues/new?template=capability.yml\">Request a capability</a></li>\n\
         <li><a href=\"{REPO}/issues/new?template=docs.yml\">Report a documentation problem</a></li>\n\
         <li><a href=\"{REPO}/releases\">Releases</a></li>\n\
         </ul></details>\n\
         </div>\n\
         </nav>\n"
    ));
    out.push_str(body);
    out.push_str("</div>\n");
    out.push_str(&footer(chrome.version, base));
    out.push_str(&format!(
        "<script src=\"{base}js/site.js?v={stamp}\" defer></script>\n\
         <script type=\"module\">import {{ init }} from '{base}js/home.js?v={stamp}'; init();</script>\n\
         </body>\n</html>\n"
    ));
    out
}

/// The page served for a URL that does not exist.
///
/// Pages serves it for any missing path, so its links are absolute rather than relative to
/// wherever the reader ended up.
///
/// # Arguments
///
/// * `chrome` - the version and navigation the shell carries.
///
/// # Returns
///
/// The complete document.
pub fn not_found(chrome: &Chrome) -> String {
    let base = chrome.base;
    let mut out = head(
        &Head {
            title: "Not found - zero-server",
            description: "There is no page at this address.",
            url: "404.html",
            kind: "website",
        },
        chrome.stamp,
        base,
    );
    out.push_str("<body>\n");
    out.push_str(&header(chrome.version, "404.html", base));
    out.push_str(&format!(
        "<div id=\"page\">\n<main class=\"content lone\" id=\"content\">\n<article class=\"article\">\n\
         <h1>There is no page here</h1>\n\
         <p>The address may have changed, or the link that brought you here may be stale. \
         The documentation is one step away.</p>\n\
         <ul>\n\
         <li><a href=\"{base}docs/index.html\">The documentation</a>, with a guide per capability</li>\n\
         <li><a href=\"{base}docs/install.html\">Install</a>, and what a narrow build costs</li>\n\
         <li><a href=\"{base}docs/about/standards.html\">Standards</a>, the documents every implementation is held to</li>\n\
         <li><a href=\"{base}docs/examples.html\">Examples</a>, every one run in CI</li>\n\
         <li><a href=\"{base}docs/reference/index.html\">The API references</a> for every language</li>\n\
         </ul>\n</article>\n</main>\n</div>\n",
    ));
    out.push_str(&footer(chrome.version, base));
    out.push_str(&format!(
        "<script src=\"/js/site.js?v={}\" defer></script>\n</body>\n</html>\n",
        chrome.stamp
    ));
    out
}

/// A page that hands a reader on to another: the root of a generated reference tree, whose
/// index is the reference page on this site.
///
/// # Arguments
///
/// * `url` - where the page sits, site-relative, so its stylesheets resolve.
/// * `target` - where it sends the reader, relative to itself.
/// * `name` - the language, for the title and the one line of text.
/// * `stamp` - the stamp that names the stylesheets.
///
/// # Returns
///
/// The complete document, which redirects at once and still reads as a page.
pub fn redirect(url: &str, target: &str, name: &str, stamp: &str) -> String {
    let root = root_of(url);
    let target = escape(target);
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n\
         <meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta http-equiv=\"refresh\" content=\"0; url={target}\">\n\
         <meta name=\"robots\" content=\"noindex\">\n\
         <link rel=\"canonical\" href=\"{target}\">\n\
         <title>{name} reference - zero-server</title>\n\
         <link rel=\"stylesheet\" href=\"{root}theme.css?v={stamp}\">\n\
         <link rel=\"stylesheet\" href=\"{root}site.css?v={stamp}\">\n\
         </head>\n<body>\n\
         <main class=\"content lone\">\n<article class=\"article\">\n\
         <h1>{name} reference</h1>\n\
         <p>The {name} reference is listed <a href=\"{target}\">one page up</a>: every package with its install line and its API pages.</p>\n\
         </article>\n</main>\n</body>\n</html>\n",
        name = escape(name),
    )
}

/// What the head of a page says about it.
struct Head<'a> {
    /// The full title, as the tab shows it.
    title: &'a str,
    /// The description, for the meta tag and the card.
    description: &'a str,
    /// The page, site-relative, for the canonical URL.
    url: &'a str,
    /// The Open Graph type: `website` for the front page, `article` for the rest.
    kind: &'a str,
}

fn head(page: &Head, stamp: &str, base: &str) -> String {
    let canonical = canonical(base, page.url);
    format!(
        "<!doctype html>\n<html lang=\"en\" class=\"no-js\" data-root=\"{base}\" data-stamp=\"{stamp}\">\n<head>\n\
         <meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{title}</title>\n\
         <meta name=\"description\" content=\"{description}\">\n\
         <meta name=\"theme-color\" content=\"{}\">\n\
         <link rel=\"canonical\" href=\"{canonical}\">\n\
         <meta property=\"og:site_name\" content=\"zero-server\">\n\
         <meta property=\"og:type\" content=\"{}\">\n\
         <meta property=\"og:title\" content=\"{title}\">\n\
         <meta property=\"og:description\" content=\"{description}\">\n\
         <meta property=\"og:url\" content=\"{canonical}\">\n\
         <meta name=\"twitter:card\" content=\"summary\">\n\
         <link rel=\"icon\" href=\"{base}assets/zero-icon.svg\">\n\
         <link rel=\"preload\" href=\"{base}fonts/Archivo.woff2\" as=\"font\" type=\"font/woff2\" crossorigin>\n\
         <link rel=\"stylesheet\" href=\"{base}fonts/fonts.css?v={stamp}\">\n\
         <link rel=\"stylesheet\" href=\"{base}theme.css?v={stamp}\">\n\
         <link rel=\"stylesheet\" href=\"{base}site.css?v={stamp}\">\n\
         <script>document.documentElement.classList.replace('no-js','js');\
try{{var h=location.hash.slice(1);document.documentElement.dataset.lang=/^(rust|typescript|python|c)$/.test(h)?h:(localStorage.getItem('zero-server:lang')||'rust')}}catch(e){{document.documentElement.dataset.lang='rust'}}\
try{{var s=localStorage.getItem('zero-server:scheme');if(s==='light'||s==='dark')document.documentElement.dataset.theme=s}}catch(e){{}}</script>\n\
         </head>\n",
        THEME_COLOR,
        page.kind,
        title = escape(page.title),
        description = escape(page.description),
        stamp = stamp,
    )
}

// The header every page shares, drawn as a datasheet's band: the mark and the part name,
// the one-line description, the site's doors, the search box, and the icon bar to the
// project on GitHub; under it the document line a sheet carries on every page, the part,
// its revision, and its license. Every page gets the menu toggle: it opens the sidebar on
// a documentation page and the drawer of site links on the front page, and site.js hides
// it where there is neither.
fn header(version: &str, here: &str, base: &str) -> String {
    let menu = "<button class=\"menu-toggle\" type=\"button\" aria-controls=\"side\" aria-expanded=\"false\">\
         <span class=\"menu-bars\" aria-hidden=\"true\"></span>Menu</button>\n";
    let matched = SECTIONS
        .iter()
        .find(|(_, _, prefix)| here.starts_with(prefix))
        .map(|(label, _, _)| *label);
    let nav: String = DOORS
        .iter()
        .map(|(label, url)| {
            let current = if matched == Some(*label) {
                " class=\"here\" aria-current=\"page\""
            } else {
                ""
            };
            format!("<a href=\"{base}{url}\"{current}>{label}</a>\n")
        })
        .collect();
    format!(
        "<header class=\"band\">\n\
         <div class=\"band-row\">\n\
         {menu}\
         <a class=\"brand\" href=\"{base}\" aria-label=\"zero-server home\">{}<span class=\"brand-word\">zero-server</span></a>\n\
         <p class=\"band-desc\">A web server core for TypeScript, Python, and C#</p>\n\
         <nav class=\"top-nav\" aria-label=\"Site\">\n{nav}</nav>\n\
         <div class=\"search\" role=\"search\">\n\
         {}\
         <input class=\"search-input\" type=\"search\" placeholder=\"Search the documentation\" aria-label=\"Search the documentation, or press slash\" autocomplete=\"off\" spellcheck=\"false\">\n\
         <kbd class=\"search-key\" aria-hidden=\"true\">/</kbd>\n\
         <div class=\"search-results\" hidden></div>\n\
         </div>\n\
         <button class=\"scheme\" type=\"button\" data-scheme=\"system\" aria-label=\"Color scheme: following your system. Activate for the light sheet.\">\
         <span class=\"scheme-icon\" aria-hidden=\"true\">{}{}{}</span><span class=\"scheme-word\">Auto</span></button>\n\
         <nav class=\"project\" aria-label=\"The project on GitHub\">\n\
         <a href=\"{REPO}\" title=\"Source on GitHub\" aria-label=\"Source on GitHub\">{}</a>\n\
         <a href=\"{REPO}/issues/new?template=bug.yml\" title=\"Report a bug\" aria-label=\"Report a bug\">{}</a>\n\
         <a href=\"{REPO}/issues/new?template=capability.yml\" title=\"Request a capability or a change\" aria-label=\"Request a capability or a change\">{}</a>\n\
         <a href=\"{REPO}/releases\" title=\"Releases and the changelog\" aria-label=\"Releases and the changelog\">{}</a>\n\
         </nav>\n\
         </div>\n\
         <p class=\"docline\"><span>zero-server</span><span>Rev {}</span><span>Apache-2.0 license</span><span class=\"docline-end\">{}</span></p>\n\
         </header>\n",
        mark(),
        ICON_GLASS,
        ICON_AUTO,
        ICON_SUN,
        ICON_MOON,
        ICON_GITHUB,
        ICON_BUG,
        ICON_REQUEST,
        ICON_TAG,
        escape(version),
        shown(base),
    )
}

/// The color the browser paints its own chrome with on the light sheet: the band's color,
/// which `web/theme.css` also carries as its `--band` token.
const THEME_COLOR: &str = "#0f5f56";

/// The doors in the band, in reading order.
const DOORS: [(&str, &str); 4] = [
    ("Docs", "docs/index.html"),
    ("Install", "docs/install.html"),
    ("Standards", "docs/about/standards.html"),
    ("Reference", "docs/reference/index.html"),
];

/// Which door the reader is behind, tried in this order: the three single destinations
/// first, then the documentation, which would otherwise claim every page under `docs/`.
const SECTIONS: [(&str, &str, &str); 4] = [
    ("Install", "docs/install.html", "docs/install"),
    (
        "Standards",
        "docs/about/standards.html",
        "docs/about/standards",
    ),
    ("Reference", "docs/reference/index.html", "docs/reference"),
    ("Docs", "docs/index.html", "docs/"),
];

/// A magnifying glass, inside the search field.
const ICON_GLASS: &str = "<svg class=\"search-glass\" viewBox=\"0 0 16 16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.6\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"7\" cy=\"7\" r=\"4.5\"/><path d=\"M10.4 10.4 14 14\"/></svg>";

/// A half-lit disc: the scheme follows the reader's system.
const ICON_AUTO: &str = "<svg class=\"i-auto\" viewBox=\"0 0 16 16\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"6\"/><path d=\"M8 2a6 6 0 0 0 0 12z\" fill=\"currentColor\" stroke=\"none\"/></svg>";

/// A sun: the light sheet.
const ICON_SUN: &str = "<svg class=\"i-sun\" viewBox=\"0 0 16 16\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"3.25\"/><path d=\"M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3.05 3.05l1.13 1.13M11.82 11.82l1.13 1.13M12.95 3.05l-1.13 1.13M4.18 11.82l-1.13 1.13\"/></svg>";

/// A moon: the sheet in reverse.
const ICON_MOON: &str = "<svg class=\"i-moon\" viewBox=\"0 0 16 16\" width=\"16\" height=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M13.2 9.7A5.6 5.6 0 0 1 6.3 2.8a5.6 5.6 0 1 0 6.9 6.9z\"/></svg>";

/// The GitHub mark, filled with the current color.
const ICON_GITHUB: &str = "<svg viewBox=\"0 0 16 16\" width=\"18\" height=\"18\" fill=\"currentColor\" aria-hidden=\"true\"><path d=\"M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z\"/></svg>";

/// A bug, drawn in strokes.
const ICON_BUG: &str = "<svg viewBox=\"0 0 16 16\" width=\"18\" height=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M5 7.5a3 3 0 0 1 6 0v2.5a3 3 0 0 1-6 0z\"/><path d=\"M6 5.2V4a2 2 0 0 1 4 0v1.2M8 7.5v5.5M2.5 8.5H5M11 8.5h2.5M3.2 12.5 5 11.3M12.8 12.5 11 11.3M3.2 4.5 5 6M12.8 4.5 11 6\"/></svg>";

/// A plus in a circle, for asking the project for something.
const ICON_REQUEST: &str = "<svg viewBox=\"0 0 16 16\" width=\"18\" height=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" aria-hidden=\"true\"><circle cx=\"8\" cy=\"8\" r=\"6.25\"/><path d=\"M8 5.2v5.6M5.2 8h5.6\"/></svg>";

/// A tag, for the releases.
const ICON_TAG: &str = "<svg viewBox=\"0 0 16 16\" width=\"18\" height=\"18\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"M2 2h5.6l6.4 6.4-5.6 5.6L2 7.6z\"/><circle cx=\"5.2\" cy=\"5.2\" r=\"1\" fill=\"currentColor\" stroke=\"none\"/></svg>";

// The mark: the mesh from the logo, turning slowly. SMIL rather than script, so it moves
// without JavaScript and stops for a reader who asked for reduced motion.
fn mark() -> &'static str {
    r##"<svg class="brand-mark" viewBox="0 0 240 240" width="30" height="30" aria-hidden="true"><g><g fill="none" stroke-width="10"><polygon points="120,40 188,80 188,160 120,200 52,160 52,80" stroke="#FBF3E4" stroke-opacity="0.28"/><g stroke="#FBF3E4" stroke-opacity="0.22"><line x1="120" y1="120" x2="120" y2="40"/><line x1="120" y1="120" x2="188" y2="80"/><line x1="120" y1="120" x2="188" y2="160"/><line x1="120" y1="120" x2="120" y2="200"/><line x1="120" y1="120" x2="52" y2="160"/><line x1="120" y1="120" x2="52" y2="80"/></g></g><g><circle cx="120" cy="40" r="13" fill="#FFB627"/><circle cx="188" cy="80" r="13" fill="#F26A4B"/><circle cx="188" cy="160" r="13" fill="#1FA995"/><circle cx="120" cy="200" r="13" fill="#FFB627"/><circle cx="52" cy="160" r="13" fill="#F26A4B"/><circle cx="52" cy="80" r="13" fill="#1FA995"/></g></g><circle cx="120" cy="120" r="22" fill="#FFB627"/></svg>"##
}

// The page's own table of contents: its second- and third-level headings, nested.
fn toc(headings: &[Heading]) -> String {
    let listed: Vec<&Heading> = headings
        .iter()
        .filter(|heading| heading.level == 2 || heading.level == 3)
        .collect();
    if listed.len() < 2 {
        return String::new();
    }
    let mut out = String::from(
        "<aside class=\"toc\">\n<nav aria-label=\"On this page\">\n<p class=\"toc-title\">On this page</p>\n<ul>\n",
    );
    let mut open_sub = false;
    for heading in listed {
        if heading.level == 3 {
            if !open_sub {
                out.push_str("<ul>\n");
                open_sub = true;
            }
        } else if open_sub {
            out.push_str("</ul>\n</li>\n");
            open_sub = false;
        } else if out.ends_with("</a>\n") {
            out.push_str("</li>\n");
        }
        out.push_str(&format!(
            "<li><a href=\"#{}\">{}</a>\n",
            escape(&heading.id),
            escape(&heading.text)
        ));
        if heading.level == 3 {
            out.push_str("</li>\n");
        }
    }
    if open_sub {
        out.push_str("</ul>\n");
    }
    out.push_str("</li>\n</ul>\n</nav>\n</aside>\n");
    out
}

fn pager(
    previous: Option<&super::nav::Item>,
    next: Option<&super::nav::Item>,
    base: &str,
) -> String {
    if previous.is_none() && next.is_none() {
        return String::new();
    }
    let mut out = String::from("<nav class=\"pager\" aria-label=\"Previous and next page\">\n");
    match previous {
        Some(item) => out.push_str(&format!(
            "<a class=\"pager-prev\" href=\"{base}{}\" rel=\"prev\"><span>Previous</span>{}</a>\n",
            item.url,
            escape(&item.title)
        )),
        None => out.push_str("<span></span>\n"),
    }
    if let Some(item) = next {
        out.push_str(&format!(
            "<a class=\"pager-next\" href=\"{base}{}\" rel=\"next\"><span>Next</span>{}</a>\n",
            item.url,
            escape(&item.title)
        ));
    }
    out.push_str("</nav>\n");
    out
}

fn footer(version: &str, base: &str) -> String {
    format!(
        "<footer class=\"foot\">\n\
         <div class=\"foot-grid\">\n\
         <div class=\"foot-notice\">\n\
         <h2 class=\"foot-head\">Important notice</h2>\n\
         <p>zero-server is free software under the Apache License 2.0: one memory-safe Rust core for HTTP with bindings for TypeScript, Python, and C#. \
         Every example on this site is spliced from a test that runs in CI on every change, every table is rendered from the source, and every number is measured by a build or read from a registry. \
         The scenarios are illustrations of what the crates do, not deployments.</p>\n\
         <p>The Apache License 2.0 disclaims every warranty. Copyright 2026 Anthony Wiedman.</p>\n\
         </div>\n\
         <nav class=\"foot-links\" aria-labelledby=\"foot-published\">\n\
         <h2 class=\"foot-head\" id=\"foot-published\">Published</h2>\n\
         <a href=\"{REPO}\">GitHub</a>\n\
         <a href=\"https://crates.io/crates/zero-server\">crates.io</a>\n\
         <a href=\"https://www.npmjs.com/package/zero-server\">npm</a>\n\
         <a href=\"https://pypi.org/project/zero-server/\">PyPI</a>\n\
         <a href=\"https://www.nuget.org/packages/ZeroServer\">NuGet</a>\n\
         </nav>\n\
         <nav class=\"foot-links\" aria-labelledby=\"foot-legal\">\n\
         <h2 class=\"foot-head\" id=\"foot-legal\">Legal</h2>\n\
         <a href=\"{base}docs/about/terms.html\">Terms</a>\n\
         <a href=\"{base}docs/about/privacy.html\">Privacy</a>\n\
         <a href=\"{base}docs/about/notices.html\">Notices</a>\n\
         <a href=\"{REPO}/blob/main/LICENSE\">Apache-2.0 license</a>\n\
         </nav>\n\
         <nav class=\"foot-links\" aria-labelledby=\"foot-contact\">\n\
         <h2 class=\"foot-head\" id=\"foot-contact\">Contact</h2>\n\
         <a href=\"{REPO}/issues/new/choose\">Open an issue</a>\n\
         <a href=\"{REPO}/security/advisories/new\">Report a vulnerability</a>\n\
         <a href=\"{base}docs/about/notices.html#contact\">Email the maintainer</a>\n\
         </nav>\n\
         </div>\n\
         <p class=\"foot-fine\"><span>zero-server</span><span>Rev {}</span><span>Apache-2.0 license</span><span class=\"foot-host\">{}</span></p>\n\
         </footer>\n",
        escape(version),
        shown(base),
    )
}

/// The site's `sitemap.xml`, one entry per page.
///
/// # Arguments
///
/// * `urls` - every page, site-relative, `index.html` included.
/// * `base` - the base path, with both slashes.
///
/// # Returns
///
/// The sitemap document.
pub fn sitemap(urls: &[&str], base: &str) -> String {
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
    );
    for url in urls {
        out.push_str(&format!(
            "<url><loc>{}</loc></url>\n",
            escape(&canonical(base, url))
        ));
    }
    out.push_str("</urlset>\n");
    out
}

/// The site's `robots.txt`: everything may be crawled, and the sitemap is named.
///
/// # Arguments
///
/// * `base` - the base path, with both slashes.
///
/// # Returns
///
/// The file's text.
pub fn robots(base: &str) -> String {
    format!("User-agent: *\nAllow: /\nSitemap: {HOST}{base}sitemap.xml\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_root_prefix_climbs_one_step_per_directory() {
        assert_eq!(root_of("docs/index.html"), "../");
        assert_eq!(root_of("docs/guides/modbus.html"), "../../");
        assert_eq!(root_of("index.html"), "");
    }

    #[test]
    fn the_head_names_the_page_for_crawlers_and_cards() {
        let html = head(
            &Head {
                title: "Modbus RTU - zero-server",
                description: "Frames & replies.",
                url: "docs/guides/modbus.html",
                kind: "article",
            },
            "0123abcd",
            DEFAULT_BASE,
        );
        assert!(html.contains(
            "<link rel=\"canonical\" href=\"https://molexxxx.github.io/zero-server/docs/guides/modbus.html\">"
        ));
        assert!(html.contains("<meta property=\"og:title\" content=\"Modbus RTU - zero-server\">"));
        assert!(
            html.contains("<meta property=\"og:description\" content=\"Frames &amp; replies.\">")
        );
        assert!(html.contains("<meta property=\"og:type\" content=\"article\">"));
        assert!(html.contains("data-root=\"/zero-server/\""));
        assert!(
            html.contains("data-stamp=\"0123abcd\""),
            "the page carries the assets' stamp"
        );
        assert!(
            html.contains("<link rel=\"stylesheet\" href=\"/zero-server/site.css?v=0123abcd\">"),
            "the stylesheet is named with the stamp under the base path"
        );
        let front = head(
            &Head {
                title: "zero-server",
                description: "x",
                url: "index.html",
                kind: "website",
            },
            "0123abcd",
            DEFAULT_BASE,
        );
        assert!(front
            .contains("<link rel=\"canonical\" href=\"https://molexxxx.github.io/zero-server/\">"));
        let at_root = head(
            &Head {
                title: "zero-server",
                description: "x",
                url: "docs/index.html",
                kind: "article",
            },
            "0123abcd",
            "/",
        );
        assert!(at_root.contains("data-root=\"/\""));
        assert!(at_root.contains(
            "<link rel=\"canonical\" href=\"https://molexxxx.github.io/docs/index.html\">"
        ));
        assert!(at_root.contains("<link rel=\"stylesheet\" href=\"/site.css?v=0123abcd\">"));
    }

    #[test]
    fn the_shell_starts_every_link_at_the_base_path() {
        let band = header("0.1.0", "docs/install.html", DEFAULT_BASE);
        assert!(band.contains("<a class=\"brand\" href=\"/zero-server/\""));
        assert!(band.contains("<a href=\"/zero-server/docs/install.html\" class=\"here\" aria-current=\"page\">Install</a>"));
        assert!(band.contains("<span class=\"docline-end\">molexxxx.github.io/zero-server</span>"));
        let foot = footer("0.1.0", DEFAULT_BASE);
        assert!(foot.contains("<a href=\"/zero-server/docs/about/terms.html\">Terms</a>"));
        assert!(foot.contains("<span class=\"foot-host\">molexxxx.github.io/zero-server</span>"));
        for html in [&band, &foot] {
            assert!(!html.contains("href=\"/docs"), "{html}");
        }
        let at_root = header("0.1.0", "index.html", "/");
        assert!(at_root.contains("<a class=\"brand\" href=\"/\""));
        assert!(at_root.contains("<a href=\"/docs/index.html\">Docs</a>"));
        assert!(at_root.contains("<span class=\"docline-end\">molexxxx.github.io</span>"));
        let pages = pager(
            Some(&super::super::nav::Item {
                title: "Install".to_owned(),
                url: "docs/install.html".to_owned(),
            }),
            None,
            DEFAULT_BASE,
        );
        assert!(pages.contains("href=\"/zero-server/docs/install.html\" rel=\"prev\""));
    }

    #[test]
    fn a_base_path_carries_both_slashes_and_no_empty_segment() {
        assert!(valid_base("/"));
        assert!(valid_base("/zero-server/"));
        assert!(valid_base("/a/b/"));
        for bad in [
            "",
            "zero-server",
            "/zero-server",
            "zero-server/",
            "//",
            "/a//b/",
        ] {
            assert!(!valid_base(bad), "{bad}");
        }
        assert_eq!(
            format!("{HOST}{DEFAULT_BASE}docs"),
            crate::catalog::SITE,
            "the catalog's absolute links point into the default site"
        );
    }

    #[test]
    fn the_sitemap_lists_every_page_at_its_public_address() {
        let map = sitemap(
            &["index.html", "docs/index.html", "docs/guides/modbus.html"],
            DEFAULT_BASE,
        );
        assert!(map.contains("<loc>https://molexxxx.github.io/zero-server/</loc>"));
        assert!(map
            .contains("<loc>https://molexxxx.github.io/zero-server/docs/guides/modbus.html</loc>"));
        assert_eq!(map.matches("<url>").count(), 3);
        assert!(robots(DEFAULT_BASE)
            .contains("Sitemap: https://molexxxx.github.io/zero-server/sitemap.xml"));
        assert!(sitemap(&["index.html"], "/").contains("<loc>https://molexxxx.github.io/</loc>"));
    }

    #[test]
    fn the_table_of_contents_nests_third_level_headings() {
        let headings = vec![
            Heading {
                level: 1,
                id: "t".into(),
                text: "Title".into(),
            },
            Heading {
                level: 2,
                id: "a".into(),
                text: "A".into(),
            },
            Heading {
                level: 3,
                id: "a-1".into(),
                text: "A one".into(),
            },
            Heading {
                level: 2,
                id: "b".into(),
                text: "B".into(),
            },
        ];
        let html = toc(&headings);
        assert!(html.contains("<li><a href=\"#a\">A</a>\n<ul>\n<li><a href=\"#a-1\">A one</a>\n</li>\n</ul>\n</li>\n<li><a href=\"#b\">B</a>\n</li>\n</ul>"), "{html}");
        assert!(!html.contains("Title"));
        assert!(toc(&headings[..2]).is_empty(), "one heading is no table");
    }
}
