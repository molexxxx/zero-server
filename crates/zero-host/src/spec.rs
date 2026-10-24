//! The option documents of routes, policies, servers and TLS listeners.
//!
//! Each is one UTF-8 JSON object, parsed with zero-json's strict parser into a typed
//! value. A key the kind does not define is refused with
//! [`Status::Codec`](crate::Status::Codec) naming it, and so is a value of the wrong
//! type or outside its range, so a typo never falls back to a default. A key given
//! twice takes its last value, as the parser resolves a repeated name. An empty
//! document is the empty object.

use std::time::Duration;

use zero_core::Value;
use zero_http::ErrorShape;
use zero_http_types::field::{validate_field_name, validate_field_value};
use zero_http_types::StatusCode;
use zero_limits::services::{
    DRAIN_RETRY_AFTER_SECS, MAX_BATCHES_IN_FLIGHT_CEILING, MAX_BATCH_SIZE, MAX_RESPONSE_BODY,
    RETRY_AFTER_SECS,
};
use zero_limits::Limits;

use crate::HostError;

/// The drain deadline of a server whose document names none.
const DEFAULT_DRAIN: Duration = Duration::from_secs(30);

/// Parse an option document into an object value; an empty document is `{}`.
fn document(context: &str, input: &[u8]) -> Result<Value, HostError> {
    if input.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Object(Vec::new()));
    }
    let value = zero_json::parse(input)
        .map_err(|err| HostError::codec(format!("the {context} options: {err}")))?;
    if value.as_object().is_none() {
        return Err(HostError::codec(format!(
            "the {context} options must be a JSON object"
        )));
    }
    Ok(value)
}

/// Reads the keys of one object, remembering which it took, so the keys nobody
/// asked for are refused at the end.
struct Reader<'a> {
    context: &'a str,
    pairs: &'a [(String, Value)],
    used: Vec<bool>,
}

impl<'a> Reader<'a> {
    fn new(context: &'a str, value: &'a Value) -> Result<Self, HostError> {
        let pairs = value.as_object().ok_or_else(|| {
            HostError::codec(format!("the {context} options must be a JSON object"))
        })?;
        Ok(Reader {
            context,
            pairs,
            used: vec![false; pairs.len()],
        })
    }

    fn refuse(&self, key: &str, what: &str) -> HostError {
        HostError::codec(format!(
            "`{key}` in the {} options must be {what}",
            self.context
        ))
    }

    fn get(&mut self, key: &str) -> Result<Option<&'a Value>, HostError> {
        let Some(position) = self.pairs.iter().position(|(name, _)| name == key) else {
            return Ok(None);
        };
        if let Some(used) = self.used.get_mut(position) {
            *used = true;
        }
        Ok(self.pairs.get(position).map(|(_, value)| value))
    }

    fn finish(self) -> Result<(), HostError> {
        match self.pairs.iter().zip(&self.used).find(|(_, used)| !**used) {
            Some(((key, _), _)) => Err(HostError::codec(format!(
                "unknown key `{key}` in the {} options",
                self.context
            ))),
            None => Ok(()),
        }
    }

    fn uint(&mut self, key: &str, low: u64, high: u64) -> Result<Option<u64>, HostError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        value
            .as_i64()
            .and_then(|number| u64::try_from(number).ok())
            .filter(|number| (low..=high).contains(number))
            .map(Some)
            .ok_or_else(|| self.refuse(key, &format!("an integer from {low} to {high}")))
    }

    fn millis(&mut self, key: &str) -> Result<Option<Duration>, HostError> {
        Ok(self.uint(key, 0, u64::MAX)?.map(Duration::from_millis))
    }

    #[cfg_attr(
        not(any(feature = "static", feature = "policy", feature = "tls")),
        allow(dead_code)
    )]
    fn bool(&mut self, key: &str) -> Result<Option<bool>, HostError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        value
            .as_bool()
            .map(Some)
            .ok_or_else(|| self.refuse(key, "true or false"))
    }

    fn string(&mut self, key: &str) -> Result<Option<&'a str>, HostError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        value
            .as_str()
            .map(Some)
            .ok_or_else(|| self.refuse(key, "a string"))
    }

    fn strings(&mut self, key: &str) -> Result<Option<Vec<&'a str>>, HostError> {
        let Some(value) = self.get(key)? else {
            return Ok(None);
        };
        let items = value
            .as_array()
            .ok_or_else(|| self.refuse(key, "an array of strings"))?;
        items
            .iter()
            .map(|item| {
                item.as_str()
                    .ok_or_else(|| self.refuse(key, "an array of strings"))
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some)
    }

    fn status(&mut self, key: &str, low: u16, high: u16) -> Result<Option<StatusCode>, HostError> {
        let Some(code) = self.uint(key, u64::from(low), u64::from(high))? else {
            return Ok(None);
        };
        u16::try_from(code)
            .ok()
            .and_then(StatusCode::new)
            .map(Some)
            .ok_or_else(|| self.refuse(key, "a status code"))
    }

    fn field_value(&mut self, key: &str) -> Result<Option<Vec<u8>>, HostError> {
        let Some(text) = self.string(key)? else {
            return Ok(None);
        };
        validate_field_value(text.as_bytes()).map_err(|_| {
            self.refuse(key, "a field value without CR, LF, NUL or edge whitespace")
        })?;
        Ok(Some(text.as_bytes().to_vec()))
    }
}

/// A field name a host may write: an RFC 9110 `token` the driver does not write
/// itself ([`zero_http::DRIVER_FIELDS`]).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.1>
pub(crate) fn writable_field_name(name: &[u8]) -> bool {
    validate_field_name(name).is_ok() && !zero_http::is_driver_field(name)
}

/// The options of a route answered by the host.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct HostSpec {
    /// The largest request body the route takes, replacing the server's.
    pub(crate) max_body: Option<u64>,
}

impl HostSpec {
    pub(crate) fn parse(input: &[u8]) -> Result<Self, HostError> {
        let value = document("host route", input)?;
        let mut reader = Reader::new("host route", &value)?;
        let spec = HostSpec {
            max_body: reader.uint("maxBody", 0, u64::MAX)?,
        };
        reader.finish()?;
        Ok(spec)
    }
}

/// The options of a redirect route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RedirectSpec {
    pub(crate) status: StatusCode,
    pub(crate) location: Vec<u8>,
}

impl RedirectSpec {
    /// The redirection statuses that take a `Location`: 301, 302, 303, 307 and 308,
    /// 302 by default. `location` is one URI reference, since "Location =
    /// URI-reference" and "The field value consists of a single URI-reference" (RFC
    /// 9110 Section 10.2.2), and "A sender MUST NOT generate protocol elements that
    /// do not match the grammar" (Section 2.2): a value RFC 3986's grammar refuses,
    /// such as one with a space or a byte past ASCII, is refused here.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.2>
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-2.2>
    pub(crate) fn parse(input: &[u8]) -> Result<Self, HostError> {
        let value = document("redirect route", input)?;
        let mut reader = Reader::new("redirect route", &value)?;
        let status = reader
            .status("status", 301, 308)?
            .unwrap_or(StatusCode::FOUND);
        if !matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308) {
            return Err(reader.refuse("status", "301, 302, 303, 307 or 308"));
        }
        let location = reader
            .field_value("location")?
            .filter(|location| !location.is_empty() && zero_uri::parse(location).is_ok())
            .ok_or_else(|| reader.refuse("location", "a non-empty URI reference"))?;
        reader.finish()?;
        Ok(RedirectSpec { status, location })
    }
}

/// Whether a response with `status` carries no content: 204 and 304 "cannot contain
/// content or trailers" (RFC 9110 Sections 15.3.5 and 15.4.5), and "a server MUST
/// NOT generate content in a 205 response" (Section 15.3.6).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.5>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.6>
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4.5>
fn without_content(status: StatusCode) -> bool {
    matches!(status.as_u16(), 204 | 205 | 304)
}

/// What the body of a route whose status carries no content must be.
const NO_CONTENT: &str = "empty for status 204, 205 and 304, which carry no content";

/// The options of a fixed response.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct FixedSpec {
    pub(crate) status: StatusCode,
    pub(crate) content_type: Option<Vec<u8>>,
    pub(crate) body: Vec<u8>,
}

impl FixedSpec {
    /// A fixed response: `status` (200 to 599, 200 by default), `contentType`, and
    /// `body` or `bodyBase64`, which must be empty for a status that carries no
    /// content.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.6>
    pub(crate) fn parse(input: &[u8]) -> Result<Self, HostError> {
        let value = document("fixed route", input)?;
        let mut reader = Reader::new("fixed route", &value)?;
        let status = reader.status("status", 200, 599)?.unwrap_or(StatusCode::OK);
        let content_type = reader.field_value("contentType")?;
        let text = reader.string("body")?;
        let encoded = reader.string("bodyBase64")?;
        let (key, body) = match (text, encoded) {
            (Some(_), Some(_)) => {
                return Err(HostError::codec(
                    "the fixed route options take `body` or `bodyBase64`, not both",
                ))
            }
            (Some(text), None) => ("body", text.as_bytes().to_vec()),
            (None, Some(encoded)) => (
                "bodyBase64",
                zero_base64::decode(encoded.as_bytes(), zero_base64::Alphabet::Standard, true)
                    .map_err(|_| reader.refuse("bodyBase64", "padded base64"))?,
            ),
            (None, None) => ("body", Vec::new()),
        };
        if without_content(status) && !body.is_empty() {
            return Err(reader.refuse(key, NO_CONTENT));
        }
        reader.finish()?;
        Ok(FixedSpec {
            status,
            content_type,
            body,
        })
    }
}

/// The options of a health route.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HealthSpec {
    pub(crate) status: StatusCode,
    pub(crate) body: Vec<u8>,
}

impl HealthSpec {
    /// A health check: `status` (200 to 599, 200 by default) and `body`, which must be
    /// empty for a status that carries no content.
    ///
    /// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.6>
    pub(crate) fn parse(input: &[u8]) -> Result<Self, HostError> {
        let value = document("health route", input)?;
        let mut reader = Reader::new("health route", &value)?;
        let status = reader.status("status", 200, 599)?.unwrap_or(StatusCode::OK);
        let body = reader
            .string("body")?
            .map_or_else(Vec::new, |body| body.as_bytes().to_vec());
        if without_content(status) && !body.is_empty() {
            return Err(reader.refuse("body", NO_CONTENT));
        }
        reader.finish()?;
        Ok(HealthSpec { status, body })
    }
}

/// The options of a static route.
#[cfg(feature = "static")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StaticSpec {
    pub(crate) root: std::path::PathBuf,
    pub(crate) options: zero_static::Options,
    /// A path the root does not serve goes on to the miss route instead of 404.
    pub(crate) fallthrough: bool,
}

#[cfg(feature = "static")]
impl StaticSpec {
    pub(crate) fn parse(input: &[u8]) -> Result<Self, HostError> {
        let value = document("static route", input)?;
        let mut reader = Reader::new("static route", &value)?;
        let root = reader
            .string("root")?
            .filter(|root| !root.is_empty())
            .ok_or_else(|| reader.refuse("root", "a non-empty directory path"))?;
        let mut options = zero_static::Options::default();
        match reader.get("index")? {
            None => {}
            Some(Value::Bool(false)) => options.index = None,
            Some(Value::Str(name)) if !name.is_empty() => options.index = Some(name.clone()),
            Some(_) => return Err(reader.refuse("index", "a file name or false")),
        }
        if let Some(milliseconds) = reader.uint("maxAgeMs", 0, u64::MAX)? {
            let seconds = u32::try_from(milliseconds / 1_000).unwrap_or(u32::MAX);
            options.cache.max_age = Some(seconds);
        }
        if let Some(dotfiles) = reader.string("dotfiles")? {
            options.dotfiles = match dotfiles {
                "ignore" => zero_static::Dotfiles::Ignore,
                "deny" => zero_static::Dotfiles::Deny,
                "allow" => zero_static::Dotfiles::Allow,
                _ => return Err(reader.refuse("dotfiles", "\"ignore\", \"deny\" or \"allow\"")),
            };
        }
        if let Some(extensions) = reader.strings("extensions")? {
            options.extensions = extensions.into_iter().map(str::to_owned).collect();
        }
        let fallthrough = reader.bool("fallthrough")?.unwrap_or(true);
        if reader.bool("etag")? == Some(false) {
            return Err(HostError::unsupported(
                "a static route always sends validators; `etag: false` is not supported",
            ));
        }
        if let Some(ranges) = reader.bool("ranges")? {
            options.ranges = ranges;
        }
        reader.finish()?;
        Ok(StaticSpec {
            root: std::path::PathBuf::from(root),
            options,
            fallthrough,
        })
    }
}

/// The options of a WebSocket route.
#[cfg(feature = "realtime")]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct WebSocketSpec {
    pub(crate) protocols: Vec<String>,
    pub(crate) origins: Option<Vec<String>>,
    pub(crate) max_payload: Option<u64>,
    pub(crate) ping_interval: Option<Duration>,
}

#[cfg(feature = "realtime")]
impl WebSocketSpec {
    pub(crate) fn parse(input: &[u8]) -> Result<Self, HostError> {
        let value = document("WebSocket route", input)?;
        let mut reader = Reader::new("WebSocket route", &value)?;
        let protocols = reader
            .strings("protocols")?
            .unwrap_or_default()
            .into_iter()
            .map(str::to_owned)
            .collect();
        let origins = match reader.get("origins")? {
            None | Some(Value::Null) => None,
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|item| {
                        item.as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| reader.refuse("origins", "an array of strings or null"))
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            ),
            Some(_) => return Err(reader.refuse("origins", "an array of strings or null")),
        };
        let spec = WebSocketSpec {
            protocols,
            origins,
            max_payload: reader.uint("maxPayload", 1, u64::MAX)?,
            ping_interval: reader.millis("pingIntervalMs")?,
        };
        reader.finish()?;
        Ok(spec)
    }
}

/// A CORS policy's options.
///
/// `origins` is `"*"` or an array of serialized origins and `.suffix` entries; every
/// entry is checked with the rule's own grammar, so an entry that could never match
/// is refused here. `credentials: true` needs `origins` as an array: with credentials
/// `Access-Control-Allow-Origin` "cannot be `*`" (Fetch, CORS protocol and
/// credentials), so a rule that allowed every origin with credentials could only
/// reflect whatever `Origin` a request sent, sharing credentialed responses with every
/// site, which the OWASP HTML5 Security Cheat Sheet rules out: "do not use `*`
/// wildcard nor blindly return the `Origin` header content without any checks".
///
/// @see <https://fetch.spec.whatwg.org/#http-cors-protocol>
/// @see <https://fetch.spec.whatwg.org/#cors-protocol-and-credentials>
/// @see <https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html#cross-origin-resource-sharing>
#[cfg(feature = "policy")]
pub(crate) fn cors(input: &[u8]) -> Result<zero_policy::Cors, HostError> {
    use zero_policy::{AllowOrigin, Cors};
    let value = document("CORS policy", input)?;
    let mut reader = Reader::new("CORS policy", &value)?;
    let mut cors = Cors::default();
    match reader.get("origins")? {
        None => {}
        Some(Value::Str(any)) if any == "*" => cors.allow_origin = AllowOrigin::Any,
        Some(Value::Array(items)) => {
            let mut list = Vec::with_capacity(items.len());
            for item in items {
                let entry = item
                    .as_str()
                    .filter(|entry| AllowOrigin::is_valid_entry(entry.as_bytes()))
                    .ok_or_else(|| {
                        reader.refuse(
                            "origins",
                            "\"*\" or an array of origins and .suffix entries",
                        )
                    })?;
                list.push(entry.as_bytes().to_vec());
            }
            cors.allow_origin = AllowOrigin::List(list);
        }
        Some(_) => {
            return Err(reader.refuse(
                "origins",
                "\"*\" or an array of origins and .suffix entries",
            ))
        }
    }
    let tokens = |reader: &mut Reader<'_>, key: &str| -> Result<Option<Vec<Vec<u8>>>, HostError> {
        let Some(items) = reader.strings(key)? else {
            return Ok(None);
        };
        items
            .into_iter()
            .map(|item| {
                if item == "*" || validate_field_name(item.as_bytes()).is_ok() {
                    Ok(item.as_bytes().to_vec())
                } else {
                    Err(reader.refuse(key, "an array of tokens or \"*\""))
                }
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some)
    };
    if let Some(methods) = tokens(&mut reader, "methods")? {
        cors.allow_methods = methods;
    }
    if let Some(headers) = tokens(&mut reader, "headers")? {
        cors.allow_headers = headers;
    }
    if let Some(expose) = tokens(&mut reader, "expose")? {
        cors.expose_headers = expose;
    }
    if let Some(credentials) = reader.bool("credentials")? {
        cors.credentials = credentials;
    }
    if cors.credentials && !matches!(cors.allow_origin, AllowOrigin::List(_)) {
        return Err(reader.refuse(
            "credentials",
            "false unless `origins` is an array of the origins allowed",
        ));
    }
    cors.max_age = reader
        .uint("maxAge", 0, u64::from(u32::MAX))?
        .and_then(|seconds| u32::try_from(seconds).ok());
    reader.finish()?;
    Ok(cors)
}

/// Field lines as name and value pairs.
#[cfg(feature = "policy")]
pub(crate) type Fields = Vec<(Vec<u8>, Vec<u8>)>;

/// A security-headers policy's options: `fields`, an array of `[name, value]` pairs,
/// each a field a host could write (RFC 9110 Section 5.5).
///
/// @see <https://www.rfc-editor.org/rfc/rfc9110.html#section-5.5>
#[cfg(feature = "policy")]
pub(crate) fn security_headers(input: &[u8]) -> Result<Fields, HostError> {
    let value = document("security headers policy", input)?;
    let mut reader = Reader::new("security headers policy", &value)?;
    let what = "an array of [name, value] pairs of valid fields";
    let mut fields = Vec::new();
    if let Some(items) = reader.get("fields")? {
        let items = items
            .as_array()
            .ok_or_else(|| reader.refuse("fields", what))?;
        for item in items {
            let pair = match item.as_array() {
                Some([Value::Str(name), Value::Str(value)])
                    if writable_field_name(name.as_bytes())
                        && validate_field_value(value.as_bytes()).is_ok() =>
                {
                    (name.as_bytes().to_vec(), value.as_bytes().to_vec())
                }
                _ => return Err(reader.refuse("fields", what)),
            };
            fields.push(pair);
        }
    }
    reader.finish()?;
    Ok(fields)
}

/// A request-id policy's options.
#[cfg(feature = "policy")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RequestIdSpec {
    /// The field the id travels in.
    pub(crate) header: Vec<u8>,
    /// Whether an acceptable incoming id is kept.
    pub(crate) trust_incoming: bool,
    /// The UUID version generated: 4 or 7.
    pub(crate) version: u8,
}

#[cfg(feature = "policy")]
impl RequestIdSpec {
    pub(crate) fn parse(input: &[u8]) -> Result<Self, HostError> {
        let value = document("request id policy", input)?;
        let mut reader = Reader::new("request id policy", &value)?;
        let header = reader.string("header")?.unwrap_or("X-Request-Id");
        if !writable_field_name(header.as_bytes()) {
            return Err(reader.refuse("header", "a field name a response may carry"));
        }
        let trust_incoming = reader.bool("trustIncoming")?.unwrap_or(false);
        let version = match reader.uint("version", 4, 7)? {
            None | Some(7) => 7,
            Some(4) => 4,
            Some(_) => return Err(reader.refuse("version", "4 or 7")),
        };
        reader.finish()?;
        Ok(RequestIdSpec {
            header: header.as_bytes().to_vec(),
            trust_incoming,
            version,
        })
    }
}

/// A trust-proxy policy's options: `cidrs`, addresses with an optional prefix
/// length, such as `10.0.0.0/8` or `::1`, and `header`, the family of forwarding
/// fields the trusted proxies write: `"x-forwarded-for"` (the default:
/// `X-Forwarded-For` names the chain and `X-Forwarded-Proto` the scheme) or
/// `"forwarded"` (the RFC 7239 `Forwarded` field alone). The other family is never
/// read, so a client cannot add a field the proxies pass through as it was sent; RFC
/// 7239 Section 8.1 warns that the field "may be modified ... by every node on the
/// way to the server, including the client making the request".
///
/// @see <https://www.rfc-editor.org/rfc/rfc7239.html#section-8.1>
#[cfg(feature = "policy")]
pub(crate) fn trust_proxy(input: &[u8]) -> Result<zero_policy::TrustProxy, HostError> {
    use zero_policy::{ForwardingHeader, TrustProxy};
    let value = document("trust proxy policy", input)?;
    let mut reader = Reader::new("trust proxy policy", &value)?;
    let what = "an array of addresses with an optional /prefix";
    let mut trusted = Vec::new();
    for entry in reader.strings("cidrs")?.unwrap_or_default() {
        let (address, prefix) = match entry.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix)),
            None => (entry, None),
        };
        let address: std::net::IpAddr =
            address.parse().map_err(|_| reader.refuse("cidrs", what))?;
        let width = if address.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            None => width,
            Some(prefix) => prefix
                .parse::<u8>()
                .ok()
                .filter(|prefix| *prefix <= width)
                .ok_or_else(|| reader.refuse("cidrs", what))?,
        };
        trusted.push((address, prefix));
    }
    let header = match reader.string("header")? {
        None => ForwardingHeader::XForwardedFor,
        Some(name) if name.eq_ignore_ascii_case("x-forwarded-for") => {
            ForwardingHeader::XForwardedFor
        }
        Some(name) if name.eq_ignore_ascii_case("forwarded") => ForwardingHeader::Forwarded,
        Some(_) => {
            return Err(reader.refuse("header", "\"x-forwarded-for\" or \"forwarded\""));
        }
    };
    reader.finish()?;
    Ok(TrustProxy::new(trusted).with_header(header))
}

/// A body-limit policy's options: `max`, the largest body in octets under the
/// policy's prefix.
#[cfg(feature = "policy")]
pub(crate) fn body_limit(input: &[u8]) -> Result<u64, HostError> {
    let value = document("body limit policy", input)?;
    let mut reader = Reader::new("body limit policy", &value)?;
    let max = reader
        .uint("max", 0, u64::MAX)?
        .ok_or_else(|| reader.refuse("max", "an integer"))?;
    reader.finish()?;
    Ok(max)
}

/// How a server is configured: where it listens, its cores, its drain, its answers to
/// overload and errors, and its limits.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServerOptions {
    /// The address to bind: an IP address or a name that resolves to one.
    pub host: String,
    /// The port; 0 lets the system pick one.
    pub port: u16,
    /// How many cores, each on its own worker index; 0 takes the smaller of the
    /// available parallelism and the free worker indexes, at least 1.
    pub threads: usize,
    /// How long a shutdown waits for in-flight work before it drops what is left.
    pub drain: Duration,
    /// The `Retry-After` seconds of a 503 for overload, no target or a lost target.
    pub retry_after_secs: u32,
    /// The `Retry-After` seconds of a 503 answered while the server drains.
    pub drain_retry_after_secs: u32,
    /// The largest response body a host may write, in octets.
    pub max_response_body: u64,
    /// The `Server` field value sent on every response, when set.
    pub server: Option<String>,
    /// The trailer names a host may read.
    pub trailers: Vec<String>,
    /// The body shape of every error answer.
    pub error_shape: ErrorShape,
    /// The HTTP/1.1 limits, the per-core memory budget and the dispatch bounds:
    /// `memory.max_batch_size`, `memory.max_batches_in_flight` and
    /// `memory.max_queued_batches_per_core`. `memory.lease_timeout` must equal
    /// `http1.request_total`, since the driver's request total is the one timer that
    /// ends a lease.
    pub limits: Limits,
}

impl Default for ServerOptions {
    fn default() -> Self {
        ServerOptions {
            host: "127.0.0.1".to_owned(),
            port: 0,
            threads: 0,
            drain: DEFAULT_DRAIN,
            retry_after_secs: RETRY_AFTER_SECS,
            drain_retry_after_secs: DRAIN_RETRY_AFTER_SECS,
            max_response_body: MAX_RESPONSE_BODY,
            server: None,
            trailers: Vec::new(),
            error_shape: ErrorShape::Problem,
            limits: Limits::DEFAULT,
        }
    }
}

impl ServerOptions {
    /// Read a server option document: `host`, `port`, `threads`, `drainMs`,
    /// `retryAfterSecs`, `drainRetryAfterSecs`, `maxResponseBody`, `maxBatchSize`
    /// (1 to 256), `maxBatchesInFlight` (1 to 8), `maxQueuedBatches`, `server`,
    /// `trailers`, `errorShape` (`"problem"` or `"legacy"`) and `limits`, whose keys
    /// are `maxBody`, `requestTotalMs` (which is also the lease timeout),
    /// `leaseTimeoutMs`, `requestMemoryPerCore` and the HTTP/1.1 limits
    /// (`maxRequestLine`, `maxHeaderField`, `maxHeaderCount`, `headerTableEntries`,
    /// `maxHeadBytes`, `maxRequestsPerConnection`, `maxPipelined`,
    /// `maxChunkSizeDigits`, `maxChunkExtension`, `maxTrailerBytes`, `receiveBlock`,
    /// `headerReadTimeoutMs`, `idleKeepAliveMs`, `bodyReadIdleMs`, `sendIdleMs`).
    ///
    /// # Arguments
    ///
    /// * `input` - the UTF-8 JSON document; empty for every default.
    ///
    /// # Returns
    ///
    /// The options, every key not given at its default.
    ///
    /// # Errors
    ///
    /// [`Status::Codec`](crate::Status::Codec) for a malformed document, an unknown
    /// key, or a value of the wrong type or outside its range; the message names the
    /// key.
    pub fn parse(input: &[u8]) -> Result<Self, HostError> {
        let value = document("server", input)?;
        let mut reader = Reader::new("server", &value)?;
        let mut options = ServerOptions::default();
        if let Some(host) = reader.string("host")? {
            options.host = host.to_owned();
        }
        if let Some(port) = reader.uint("port", 0, u64::from(u16::MAX))? {
            options.port = u16::try_from(port).unwrap_or(0);
        }
        if let Some(threads) = reader.uint("threads", 0, 128)? {
            options.threads = usize::try_from(threads).unwrap_or(0);
        }
        if let Some(drain) = reader.millis("drainMs")? {
            options.drain = drain;
        }
        let seconds = u64::from(u32::MAX);
        if let Some(retry) = reader.uint("retryAfterSecs", 0, seconds)? {
            options.retry_after_secs = u32::try_from(retry).unwrap_or(u32::MAX);
        }
        if let Some(retry) = reader.uint("drainRetryAfterSecs", 0, seconds)? {
            options.drain_retry_after_secs = u32::try_from(retry).unwrap_or(u32::MAX);
        }
        if let Some(max) = reader.uint("maxResponseBody", 0, u64::MAX)? {
            options.max_response_body = max;
        }
        let memory = &mut options.limits.memory;
        let batch = u64::try_from(MAX_BATCH_SIZE).unwrap_or(256);
        if let Some(size) = reader.uint("maxBatchSize", 1, batch)? {
            memory.max_batch_size = usize::try_from(size).unwrap_or(MAX_BATCH_SIZE);
        }
        let ceiling = u64::try_from(MAX_BATCHES_IN_FLIGHT_CEILING).unwrap_or(8);
        if let Some(in_flight) = reader.uint("maxBatchesInFlight", 1, ceiling)? {
            memory.max_batches_in_flight = usize::try_from(in_flight).unwrap_or(1);
        }
        if let Some(queued) = reader.uint("maxQueuedBatches", 1, 65_536)? {
            memory.max_queued_batches_per_core = usize::try_from(queued).unwrap_or(1);
        }
        if let Some(server) = reader.field_value("server")? {
            options.server = Some(String::from_utf8_lossy(&server).into_owned());
        }
        if let Some(trailers) = reader.strings("trailers")? {
            for name in &trailers {
                if validate_field_name(name.as_bytes()).is_err() {
                    return Err(reader.refuse("trailers", "an array of field names"));
                }
            }
            options.trailers = trailers.into_iter().map(str::to_owned).collect();
        }
        if let Some(shape) = reader.string("errorShape")? {
            options.error_shape = match shape {
                "problem" => ErrorShape::Problem,
                "legacy" => ErrorShape::Legacy,
                _ => return Err(reader.refuse("errorShape", "\"problem\" or \"legacy\"")),
            };
        }
        if let Some(limits) = reader.get("limits")? {
            read_limits(limits, &mut options.limits)?;
        }
        reader.finish()?;
        Ok(options)
    }
}

/// Read the `limits` object of a server document into `limits`.
fn read_limits(value: &Value, limits: &mut Limits) -> Result<(), HostError> {
    let mut reader = Reader::new("server limits", value)?;
    let size = |reader: &mut Reader<'_>, key: &str, into: &mut usize| -> Result<(), HostError> {
        if let Some(number) = reader.uint(key, 0, u64::from(u32::MAX))? {
            *into = usize::try_from(number).unwrap_or(usize::MAX);
        }
        Ok(())
    };
    let time = |reader: &mut Reader<'_>, key: &str, into: &mut Duration| -> Result<(), HostError> {
        if let Some(duration) = reader.millis(key)? {
            *into = duration;
        }
        Ok(())
    };
    let http1 = &mut limits.http1;
    size(&mut reader, "maxRequestLine", &mut http1.max_request_line)?;
    size(&mut reader, "maxHeaderField", &mut http1.max_header_field)?;
    size(&mut reader, "maxHeaderCount", &mut http1.max_header_count)?;
    size(
        &mut reader,
        "headerTableEntries",
        &mut http1.header_table_entries,
    )?;
    size(&mut reader, "maxHeadBytes", &mut http1.max_head_bytes)?;
    size(&mut reader, "maxPipelined", &mut http1.max_pipelined)?;
    size(
        &mut reader,
        "maxChunkSizeDigits",
        &mut http1.max_chunk_size_digits,
    )?;
    size(
        &mut reader,
        "maxChunkExtension",
        &mut http1.max_chunk_extension,
    )?;
    size(&mut reader, "maxTrailerBytes", &mut http1.max_trailer_bytes)?;
    size(&mut reader, "receiveBlock", &mut http1.receive_block)?;
    if let Some(max) = reader.uint("maxBody", 0, u64::MAX)? {
        http1.max_body = max;
    }
    if let Some(count) = reader.uint("maxRequestsPerConnection", 1, u64::from(u32::MAX))? {
        http1.max_requests_per_connection = u32::try_from(count).unwrap_or(u32::MAX);
    }
    time(
        &mut reader,
        "headerReadTimeoutMs",
        &mut http1.header_read_timeout,
    )?;
    time(&mut reader, "idleKeepAliveMs", &mut http1.idle_keep_alive)?;
    time(&mut reader, "bodyReadIdleMs", &mut http1.body_read_idle)?;
    time(&mut reader, "sendIdleMs", &mut http1.send_idle)?;
    if let Some(total) = reader.millis("requestTotalMs")? {
        http1.request_total = total;
        limits.memory.lease_timeout = total;
    }
    time(
        &mut reader,
        "leaseTimeoutMs",
        &mut limits.memory.lease_timeout,
    )?;
    if let Some(budget) = reader.uint("requestMemoryPerCore", 1, u64::MAX)? {
        limits.memory.request_memory_per_core = budget;
    }
    reader.finish()
}

/// A TLS listener's options: `alpn`, `minVersion` and `maxVersion` (`"1.2"` or
/// `"1.3"`, and TLS 1.3 is always offered), `requireEms`, and `names`, the hosts the
/// certificate serves. Each `alpn` entry is a protocol name of 1 to 255 octets, the
/// bounds of `opaque ProtocolName<1..2^8-1>`, since "Empty strings MUST NOT be
/// included" (RFC 7301 Section 3.1).
///
/// @see <https://www.rfc-editor.org/rfc/rfc7301.html#section-3.1>
#[cfg(feature = "tls")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct TlsSpec {
    pub(crate) alpn: Vec<Vec<u8>>,
    pub(crate) tls12: bool,
    pub(crate) require_ems: bool,
    pub(crate) names: Vec<String>,
}

#[cfg(feature = "tls")]
impl TlsSpec {
    pub(crate) fn parse(input: &[u8]) -> Result<Self, HostError> {
        let value = document("TLS", input)?;
        let mut reader = Reader::new("TLS", &value)?;
        let defaults = zero_tls::TlsOptions::default();
        let alpn = reader.strings("alpn")?.map_or(defaults.alpn, |protocols| {
            protocols
                .into_iter()
                .map(|protocol| protocol.as_bytes().to_vec())
                .collect()
        });
        if alpn
            .iter()
            .any(|protocol| protocol.is_empty() || protocol.len() > 255)
        {
            return Err(reader.refuse("alpn", "protocol names of 1 to 255 octets"));
        }
        let tls12 = match reader.string("minVersion")? {
            None | Some("1.2") => defaults.tls12,
            Some("1.3") => false,
            Some(_) => return Err(reader.refuse("minVersion", "\"1.2\" or \"1.3\"")),
        };
        match reader.string("maxVersion")? {
            None | Some("1.3") => {}
            Some(_) => return Err(reader.refuse("maxVersion", "\"1.3\"")),
        }
        let require_ems = reader.bool("requireEms")?.unwrap_or(defaults.require_ems);
        let names = reader
            .strings("names")?
            .unwrap_or_default()
            .into_iter()
            .map(str::to_owned)
            .collect();
        reader.finish()?;
        Ok(TlsSpec {
            alpn,
            tls12,
            require_ems,
            names,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{FixedSpec, HealthSpec, HostSpec, RedirectSpec, ServerOptions};
    use crate::Status;

    #[test]
    fn an_unknown_key_is_refused_with_codec_and_named() {
        let refused = HostSpec::parse(br#"{"maxbody":1}"#).unwrap_err();
        assert_eq!(refused.status(), Status::Codec);
        assert!(refused.message().contains("`maxbody`"), "{refused}");
        let twice = HostSpec::parse(br#"{"maxBody":1,"maxBody":2}"#).unwrap();
        assert_eq!(
            twice.max_body,
            Some(2),
            "the last value of a repeated key wins"
        );
        let typed = ServerOptions::parse(br#"{"threads":"two"}"#).unwrap_err();
        assert!(typed.message().contains("`threads`"), "{typed}");
        assert_eq!(HostSpec::parse(b"").unwrap(), HostSpec::default());
        assert_eq!(
            ServerOptions::parse(b"[]").unwrap_err().status(),
            Status::Codec
        );
    }

    #[test]
    fn server_documents_set_their_limits_and_the_request_total_is_the_lease_timeout() {
        let options = ServerOptions::parse(
            br#"{"threads":2,"maxBatchSize":8,"maxBatchesInFlight":2,"maxQueuedBatches":3,
                "errorShape":"legacy","limits":{"requestTotalMs":5000,"maxPipelined":32}}"#,
        )
        .unwrap();
        assert_eq!(options.threads, 2);
        assert_eq!(options.limits.memory.max_batch_size, 8);
        assert_eq!(options.limits.memory.max_batches_in_flight, 2);
        assert_eq!(options.limits.memory.max_queued_batches_per_core, 3);
        assert_eq!(options.error_shape, zero_http::ErrorShape::Legacy);
        assert_eq!(options.limits.http1.max_pipelined, 32);
        assert_eq!(
            options.limits.http1.request_total,
            std::time::Duration::from_secs(5)
        );
        assert_eq!(
            options.limits.memory.lease_timeout,
            options.limits.http1.request_total
        );
        for refused in [
            &br#"{"maxBatchSize":0}"#[..],
            br#"{"maxBatchSize":257}"#,
            br#"{"maxBatchesInFlight":9}"#,
            br#"{"errorShape":"html"}"#,
            br#"{"limits":{"maxBody":-1}}"#,
            br#"{"limits":{"unknown":1}}"#,
            br#"{"server":"a\nb"}"#,
        ] {
            assert_eq!(
                ServerOptions::parse(refused).unwrap_err().status(),
                Status::Codec,
                "{}",
                String::from_utf8_lossy(refused)
            );
        }
    }

    #[test]
    fn route_documents_are_checked_at_registration() {
        let fixed =
            FixedSpec::parse(br#"{"status":201,"contentType":"text/plain","bodyBase64":"aGk="}"#)
                .unwrap();
        assert_eq!(
            (fixed.status.as_u16(), fixed.body.as_slice()),
            (201, &b"hi"[..])
        );
        assert!(FixedSpec::parse(br#"{"body":"a","bodyBase64":"aGk="}"#).is_err());
        assert!(FixedSpec::parse(br#"{"status":101}"#).is_err());
        let redirect = RedirectSpec::parse(br#"{"location":"/next"}"#).unwrap();
        assert_eq!(redirect.status.as_u16(), 302);
        assert!(RedirectSpec::parse(br#"{"status":304,"location":"/"}"#).is_err());
        assert!(RedirectSpec::parse(br#"{"status":301}"#).is_err());
    }

    #[test]
    fn a_fixed_or_health_route_with_status_204_205_or_304_carries_no_content_9110_15_3_6() {
        for status in [204, 205, 304] {
            for document in [
                format!(r#"{{"status":{status},"body":"ok"}}"#),
                format!(r#"{{"status":{status},"bodyBase64":"aGk="}}"#),
            ] {
                let refused = FixedSpec::parse(document.as_bytes()).unwrap_err();
                assert_eq!(refused.status(), Status::Codec, "{document}");
                assert!(refused.message().contains("`body"), "{refused}");
            }
            let health = format!(r#"{{"status":{status},"body":"ok"}}"#);
            let refused = HealthSpec::parse(health.as_bytes()).unwrap_err();
            assert!(refused.message().contains("`body`"), "{refused}");
            let empty = format!(r#"{{"status":{status},"body":""}}"#);
            assert!(FixedSpec::parse(empty.as_bytes()).unwrap().body.is_empty());
            assert!(HealthSpec::parse(empty.as_bytes()).is_ok());
        }
        assert!(FixedSpec::parse(br#"{"status":200,"body":"ok"}"#).is_ok());
    }

    #[test]
    fn a_redirect_location_is_a_single_uri_reference_9110_10_2_2() {
        for location in [
            "/next",
            "https://example.com/a?b=c#d",
            "../up",
            "//cdn.example/x",
            "/a%20b",
        ] {
            let document = format!(r#"{{"location":"{location}"}}"#);
            assert!(
                RedirectSpec::parse(document.as_bytes()).is_ok(),
                "{location}"
            );
        }
        for location in ["/a b", "/<x>", "/caf\u{e9}", "1:x", "/a\"b", ""] {
            let document = zero_json::to_vec(&zero_core::Value::Object(vec![(
                "location".to_owned(),
                zero_core::Value::Str(location.to_owned()),
            )]))
            .unwrap();
            let refused = RedirectSpec::parse(&document).unwrap_err();
            assert_eq!(refused.status(), Status::Codec, "{location}");
            assert!(refused.message().contains("`location`"), "{refused}");
        }
    }
}
