//! The .NET mirror of the C header. `cargo xtask ffi-mirror --write | --check` renders
//! `bindings/dotnet/src/ZeroServer.Native/Interop/NativeMethods.g.cs` from
//! `crates/zero-ffi/include/zero.h`: one `[LibraryImport]` per prototype in the
//! `NativeMethods` partial class and one sequential struct per header struct. The header
//! reader here is shared with the `surface` task, and it reads the header the way a C17
//! compiler does, so the C++ and C23 blocks cbindgen writes never reach it.
//!
//! The type map: fixed-width integers to the C# integer of the same width and signedness,
//! `uintptr_t` to `nuint`, a header struct or enum to the C# type of the same name, a
//! pointer to a typed pointer, a pointer to an opaque handle to `nint`, a returned pointer
//! to `nint` (the caller hands it to `Marshal` or to another import), and a function
//! pointer to `delegate* unmanaged<...>`. Header enums are not generated: each is a
//! hand-written C# enum that `surface --check` compares member by member.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

/// The committed C header, relative to the repository root.
pub(crate) const HEADER: &str = "crates/zero-ffi/include/zero.h";

/// The generated .NET declarations, relative to the repository root.
pub(crate) const MIRROR: &str = "bindings/dotnet/src/ZeroServer.Native/Interop/NativeMethods.g.cs";

/// The imports that skip the GC transition. The attribute requires a native function that
/// runs for a trivial time and never blocks, calls back into the runtime, throws or takes
/// a lock or another concurrency primitive; each of these four reads a constant or a slot
/// value and does none of that, so the transition would cost more than the call.
///
/// @see <https://learn.microsoft.com/en-us/dotnet/api/system.runtime.interopservices.suppressgctransitionattribute#remarks>
pub(crate) const SUPPRESS_GC_TRANSITION: [&str; 4] = [
    "zero_abi_version",
    "zero_req_view",
    "zero_req_method",
    "zero_slot_route",
];

/// The reserved keywords of C#, which a C identifier escapes with `@` when it becomes a C#
/// name. The contextual keywords are valid identifiers and stay as they are.
///
/// @see <https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/>
const CS_KEYWORDS: [&str; 77] = [
    "abstract",
    "as",
    "base",
    "bool",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "checked",
    "class",
    "const",
    "continue",
    "decimal",
    "default",
    "delegate",
    "do",
    "double",
    "else",
    "enum",
    "event",
    "explicit",
    "extern",
    "false",
    "finally",
    "fixed",
    "float",
    "for",
    "foreach",
    "goto",
    "if",
    "implicit",
    "in",
    "int",
    "interface",
    "internal",
    "is",
    "lock",
    "long",
    "namespace",
    "new",
    "null",
    "object",
    "operator",
    "out",
    "override",
    "params",
    "private",
    "protected",
    "public",
    "readonly",
    "ref",
    "return",
    "sbyte",
    "sealed",
    "short",
    "sizeof",
    "stackalloc",
    "static",
    "string",
    "struct",
    "switch",
    "this",
    "throw",
    "true",
    "try",
    "typeof",
    "uint",
    "ulong",
    "unchecked",
    "unsafe",
    "ushort",
    "using",
    "virtual",
    "void",
    "volatile",
    "while",
];

/// A C type as a declaration spells it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CType {
    /// A named type behind `pointers` levels of indirection.
    Named {
        /// The type name, its qualifiers removed (`uint8_t`, `ZeroBytes`, `void`).
        name: String,
        /// How many `*` follow it.
        pointers: usize,
    },
    /// A fixed-length array of a named type, as a struct field declares one.
    Array {
        /// The element type name.
        element: String,
        /// The element count.
        len: usize,
    },
    /// A pointer to a function.
    Function(Box<Signature>),
}

/// A function's return type and parameters.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Signature {
    /// The return type.
    pub(crate) returns: CType,
    /// The parameters, in order.
    pub(crate) params: Vec<Param>,
}

/// One named parameter or struct field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Param {
    /// The name, or `argN` when the declaration names none.
    pub(crate) name: String,
    /// The type.
    pub(crate) ty: CType,
    /// The documentation comment above it, one entry per line.
    pub(crate) doc: Vec<String>,
}

/// A prototype.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Function {
    /// The exported symbol.
    pub(crate) name: String,
    /// The signature.
    pub(crate) signature: Signature,
    /// The documentation comment above it, one entry per line.
    pub(crate) doc: Vec<String>,
}

/// A struct with a body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Struct {
    /// The type name.
    pub(crate) name: String,
    /// The fields, in declaration order.
    pub(crate) fields: Vec<Param>,
    /// The documentation comment above it, one entry per line.
    pub(crate) doc: Vec<String>,
}

/// An enum and its values.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Enum {
    /// The type name.
    pub(crate) name: String,
    /// The integer type a `typedef` gives it, or `None` for the C default of `int`.
    pub(crate) underlying: Option<String>,
    /// Each variant as the header spells it, with its value.
    pub(crate) variants: Vec<(String, i128)>,
}

/// What a C header declares, in declaration order within each kind.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Header {
    /// The opaque struct types.
    pub(crate) opaque: Vec<String>,
    /// The structs with a body.
    pub(crate) structs: Vec<Struct>,
    /// The enums.
    pub(crate) enums: Vec<Enum>,
    /// The function pointer typedefs.
    pub(crate) callbacks: Vec<(String, Signature)>,
    /// The other typedefs.
    pub(crate) aliases: Vec<(String, CType)>,
    /// The prototypes.
    pub(crate) functions: Vec<Function>,
}

/// Where a C type appears, which decides how a pointer maps to C#.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Position {
    /// A return type.
    Return,
    /// A parameter.
    Param,
    /// A struct field.
    Field,
}

/// Run `cargo xtask ffi-mirror --write | --check`.
///
/// # Arguments
///
/// * `args` - `--write` renders the declarations from the header; `--check` verifies the
///   committed file matches.
///
/// # Returns
///
/// Success when the file was written, or when the check found it in sync.
pub(crate) fn run(args: &[String]) -> ExitCode {
    let Some(check) = mode(args, "ffi-mirror") else {
        return ExitCode::FAILURE;
    };
    let root = crate::docs::repo_root();
    let rendered = fs::read_to_string(root.join(HEADER))
        .map_err(|err| format!("reading {HEADER}: {err}"))
        .and_then(|text| parse_header(&text))
        .and_then(|header| render(&header));
    match rendered {
        Ok(text) if sync(&root, MIRROR, &text, "ffi-mirror", check) => ExitCode::SUCCESS,
        Ok(_) => ExitCode::FAILURE,
        Err(message) => {
            eprintln!("xtask ffi-mirror: {message}");
            ExitCode::FAILURE
        }
    }
}

/// Read the `--write` or `--check` argument of a generator task.
///
/// # Arguments
///
/// * `args` - the task's arguments.
/// * `task` - the task name, for the usage line.
///
/// # Returns
///
/// `Some(true)` for `--check`, `Some(false)` for `--write`, and `None` (after printing the
/// usage) for anything else.
pub(crate) fn mode(args: &[String], task: &str) -> Option<bool> {
    match args {
        [arg] if arg == "--check" => Some(true),
        [arg] if arg == "--write" => Some(false),
        _ => {
            eprintln!("usage: cargo xtask {task} --write | --check");
            None
        }
    }
}

/// Write one generated file, or verify the committed copy matches it.
///
/// # Arguments
///
/// * `root` - the repository root.
/// * `relative` - the file, relative to the root.
/// * `rendered` - what the generator produced.
/// * `task` - the task name, for the messages.
/// * `check` - verify instead of writing.
///
/// # Returns
///
/// Whether the file was written, or found in sync.
pub(crate) fn sync(root: &Path, relative: &str, rendered: &str, task: &str, check: bool) -> bool {
    let path = root.join(relative);
    if check {
        return match fs::read_to_string(&path) {
            Ok(on_disk) if on_disk == rendered => {
                println!("{task}: {relative} is in sync");
                true
            }
            Ok(_) => {
                eprintln!(
                    "xtask {task}: {relative} is stale\n  run `cargo xtask {task} --write` and commit the result"
                );
                false
            }
            Err(err) => {
                eprintln!(
                    "xtask {task}: {relative} is missing ({err})\n  run `cargo xtask {task} --write` and commit the result"
                );
                false
            }
        };
    }
    if let Some(parent) = path.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            eprintln!("xtask {task}: creating {}: {err}", parent.display());
            return false;
        }
    }
    match fs::write(&path, rendered) {
        Ok(()) => {
            println!("{task}: wrote {relative}");
            true
        }
        Err(err) => {
            eprintln!("xtask {task}: writing {relative}: {err}");
            false
        }
    }
}

/// One top-level declaration of the header: the comment lines directly above it, its text
/// with comments, and its text with every comment replaced by a space.
struct Statement {
    doc: Vec<String>,
    raw: String,
    code: String,
}

/// Read a C header the way cbindgen writes one.
///
/// # Arguments
///
/// * `text` - the header.
///
/// # Returns
///
/// What it declares for a C17 compiler: the groups its conditionals skip, the C++ and C23
/// blocks among them, are not read.
///
/// # Errors
///
/// A declaration this reader does not recognize, a conditional it cannot evaluate, an
/// unbalanced conditional, an `#error` the compiler would reach, or an unterminated
/// declaration, named in the message.
pub(crate) fn parse_header(text: &str) -> Result<Header, String> {
    let code = preprocess(text)?;
    let mut header = Header::default();
    for statement in statements(&code)? {
        classify(&mut header, &statement)?;
    }
    let mut aliases = Vec::new();
    for (name, ty) in std::mem::take(&mut header.aliases) {
        let underlying = match &ty {
            CType::Named {
                name: base,
                pointers: 0,
            } => Some(base.clone()),
            _ => None,
        };
        match (header.enums.iter_mut().find(|e| e.name == name), underlying) {
            (Some(target), Some(base)) => target.underlying = Some(base),
            _ => aliases.push((name, ty)),
        }
    }
    header.aliases = aliases;
    Ok(header)
}

/// The macros the modeled C17 implementation predefines that a condition can test, with
/// their values. It is a hosted implementation with no macro of its own, so `__cplusplus`,
/// `_WIN32` and the like are undefined; a block cbindgen guards for C++ or C23 is skipped
/// and its C17 alternative is read.
///
/// @see <https://www.open-std.org/jtc1/sc22/wg14/www/docs/n2310.pdf> Section 6.10.8.1
/// (Mandatory macros) and Annex M.2 (`__STDC_VERSION__` is 201710L in the fourth edition)
const PREDEFINED: [(&str, i128); 3] = [
    ("__STDC__", 1),
    ("__STDC_HOSTED__", 1),
    ("__STDC_VERSION__", 201_710),
];

/// The macros a header defines, by name: the replacement list of an object-like macro, or
/// `None` for a function-like one.
type Macros = BTreeMap<String, Option<String>>;

/// One open conditional: whether its current group is processed, and whether one of its
/// groups already was. A conditional inside a skipped group counts as taken, so none of its
/// groups is processed.
struct Conditional {
    current: bool,
    taken: bool,
}

/// Drop the preprocessor lines and keep the code a C17 compiler processes: of each
/// conditional, the first group whose condition is nonzero, or else its `#else` group, and
/// nothing of a skipped group, whose directives are followed only to track the nesting. A
/// `#define` or `#undef` in a processed group changes the macros later conditions test,
/// and lines that end in a backslash are spliced first. Line breaks are kept so positions
/// stay meaningful.
///
/// @see <https://www.open-std.org/jtc1/sc22/wg14/www/docs/n2310.pdf> Section 6.10.1
/// (Conditional inclusion)
fn preprocess(text: &str) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut macros = Macros::new();
    let mut stack: Vec<Conditional> = Vec::new();
    let mut lines = text.lines().enumerate();
    while let Some((index, first)) = lines.next() {
        let number = index + 1;
        let mut line = first.to_owned();
        let mut breaks = 1;
        while line.ends_with('\\') {
            line.pop();
            let Some((_, next)) = lines.next() else {
                break;
            };
            line.push_str(next);
            breaks += 1;
        }
        let active = stack.iter().all(|open| open.current);
        if let Some(directive) = line.trim_start().strip_prefix('#') {
            let directive = strip_comments(directive);
            let directive = directive.trim();
            let (word, rest) = directive
                .split_once(char::is_whitespace)
                .map_or((directive, ""), |(word, rest)| (word, rest.trim()));
            let at = |err: String| {
                if rest.is_empty() {
                    format!("line {number}: #{word}: {err}")
                } else {
                    format!("line {number}: #{word} {rest}: {err}")
                }
            };
            match word {
                "if" | "ifdef" | "ifndef" => {
                    let current = active
                        && match word {
                            "if" => condition(rest, &macros).map_err(at)?,
                            "ifdef" => is_defined(macro_name(rest).map_err(at)?, &macros),
                            _ => !is_defined(macro_name(rest).map_err(at)?, &macros),
                        };
                    stack.push(Conditional {
                        current,
                        taken: current || !active,
                    });
                }
                "elif" => {
                    let top = stack
                        .last_mut()
                        .ok_or_else(|| at("no #if is open".to_owned()))?;
                    if top.taken {
                        top.current = false;
                    } else {
                        top.current = condition(rest, &macros).map_err(at)?;
                        top.taken = top.current;
                    }
                }
                "else" => {
                    let top = stack
                        .last_mut()
                        .ok_or_else(|| at("no #if is open".to_owned()))?;
                    top.current = !top.taken;
                    top.taken = true;
                }
                "endif" => {
                    stack.pop().ok_or_else(|| at("no #if is open".to_owned()))?;
                }
                "define" if active => {
                    let (name, value) = rest
                        .split_once(char::is_whitespace)
                        .map_or((rest, ""), |(name, value)| (name, value.trim()));
                    match name.split_once('(') {
                        Some((name, _)) => macros.insert(name.to_owned(), None),
                        None => macros.insert(name.to_owned(), Some(value.to_owned())),
                    };
                }
                "undef" if active => {
                    macros.remove(macro_name(rest).map_err(at)?);
                }
                "error" if active => {
                    return Err(at("the compiler stops at this directive".to_owned()));
                }
                _ => {}
            }
        } else if active {
            out.push_str(&line);
        }
        for _ in 0..breaks {
            out.push('\n');
        }
    }
    if stack.is_empty() {
        Ok(out)
    } else {
        Err("an #if is never closed".to_owned())
    }
}

/// The one macro name an `#ifdef`, `#ifndef` or `#undef` directive names.
fn macro_name(rest: &str) -> Result<&str, String> {
    let mut words = rest.split_whitespace();
    match (words.next(), words.next()) {
        (Some(name), None) if is_identifier(name) => Ok(name),
        _ => Err("the directive takes one macro name".to_owned()),
    }
}

/// Whether a macro is defined: predefined, or the subject of a processed `#define` without
/// an `#undef` after it.
///
/// @see <https://www.open-std.org/jtc1/sc22/wg14/www/docs/n2310.pdf> Section 6.10.1
/// (Conditional inclusion), paragraphs 1 and 5
fn is_defined(name: &str, macros: &Macros) -> bool {
    PREDEFINED.iter().any(|(predefined, _)| *predefined == name) || macros.contains_key(name)
}

/// The value a C17 compiler gives a `#if` condition: `defined` is 1 for a defined macro
/// and 0 otherwise, an object-like macro is replaced by its replacement list, and every
/// identifier that remains after the replacements is 0.
///
/// @see <https://www.open-std.org/jtc1/sc22/wg14/www/docs/n2310.pdf> Section 6.10.1
/// (Conditional inclusion), paragraph 4
fn condition(text: &str, macros: &Macros) -> Result<bool, String> {
    Ok(evaluate(text, macros, &[])? != 0)
}

/// Evaluate one condition. `expanding` holds the macros whose replacement lists are being
/// evaluated: such a name is not replaced again, so it remains and is 0.
fn evaluate(text: &str, macros: &Macros, expanding: &[&str]) -> Result<i128, String> {
    let tokens = condition_tokens(text)?;
    if tokens.is_empty() {
        return Err("the condition is empty".to_owned());
    }
    let mut expr = ConditionExpr {
        tokens: &tokens,
        at: 0,
        macros,
        expanding,
    };
    let value = expr.or()?;
    if expr.at == tokens.len() {
        Ok(value)
    } else {
        Err(format!("`{}` is not one expression", text.trim()))
    }
}

/// A token of a `#if` condition.
#[derive(Debug, PartialEq, Eq)]
enum ConditionToken {
    Number(i128),
    Ident(String),
    Op(&'static str),
}

/// The operators a `#if` condition may use here, longest first. cbindgen writes `defined`,
/// `!`, `&&`, `||` and the comparisons; any other operator is refused rather than guessed.
const CONDITION_OPS: [&str; 11] = ["||", "&&", ">=", "<=", "==", "!=", ">", "<", "!", "(", ")"];

/// Split a `#if` condition into tokens.
fn condition_tokens(text: &str) -> Result<Vec<ConditionToken>, String> {
    let mut out = Vec::new();
    let mut rest = text.trim_start();
    while let Some(first) = rest.chars().next() {
        if first.is_ascii_alphanumeric() || first == '_' {
            let end = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .unwrap_or(rest.len());
            let word = &rest[..end];
            out.push(if first.is_ascii_digit() {
                ConditionToken::Number(integer(word)?)
            } else {
                ConditionToken::Ident(word.to_owned())
            });
            rest = &rest[end..];
        } else {
            let op = *CONDITION_OPS
                .iter()
                .find(|op| rest.starts_with(**op))
                .ok_or_else(|| format!("`{first}` is not an operator the reader evaluates"))?;
            out.push(ConditionToken::Op(op));
            rest = &rest[op.len()..];
        }
        rest = rest.trim_start();
    }
    Ok(out)
}

/// A recursive-descent reader of a `#if` condition.
struct ConditionExpr<'a> {
    tokens: &'a [ConditionToken],
    at: usize,
    macros: &'a Macros,
    expanding: &'a [&'a str],
}

impl ConditionExpr<'_> {
    fn eat(&mut self, op: &str) -> bool {
        let found =
            matches!(self.tokens.get(self.at), Some(ConditionToken::Op(next)) if *next == op);
        if found {
            self.at += 1;
        }
        found
    }

    fn or(&mut self) -> Result<i128, String> {
        let mut value = self.and()?;
        while self.eat("||") {
            let rhs = self.and()?;
            value = i128::from(value != 0 || rhs != 0);
        }
        Ok(value)
    }

    fn and(&mut self) -> Result<i128, String> {
        let mut value = self.compare()?;
        while self.eat("&&") {
            let rhs = self.compare()?;
            value = i128::from(value != 0 && rhs != 0);
        }
        Ok(value)
    }

    fn compare(&mut self) -> Result<i128, String> {
        let lhs = self.unary()?;
        for op in [">=", "<=", "==", "!=", ">", "<"] {
            if self.eat(op) {
                let rhs = self.unary()?;
                return Ok(i128::from(match op {
                    ">=" => lhs >= rhs,
                    "<=" => lhs <= rhs,
                    "==" => lhs == rhs,
                    "!=" => lhs != rhs,
                    ">" => lhs > rhs,
                    _ => lhs < rhs,
                }));
            }
        }
        Ok(lhs)
    }

    fn unary(&mut self) -> Result<i128, String> {
        if self.eat("!") {
            return Ok(i128::from(self.unary()? == 0));
        }
        if self.eat("(") {
            let value = self.or()?;
            return if self.eat(")") {
                Ok(value)
            } else {
                Err("a parenthesis is never closed".to_owned())
            };
        }
        let tokens = self.tokens;
        match tokens.get(self.at) {
            Some(ConditionToken::Number(value)) => {
                self.at += 1;
                Ok(*value)
            }
            Some(ConditionToken::Ident(name)) if name == "defined" => {
                self.at += 1;
                let parenthesized = self.eat("(");
                let Some(ConditionToken::Ident(subject)) = tokens.get(self.at) else {
                    return Err("`defined` takes one macro name".to_owned());
                };
                self.at += 1;
                if parenthesized && !self.eat(")") {
                    return Err("`defined(` is never closed".to_owned());
                }
                Ok(i128::from(is_defined(subject, self.macros)))
            }
            Some(ConditionToken::Ident(name)) => {
                self.at += 1;
                if let Some((_, value)) = PREDEFINED
                    .iter()
                    .find(|(predefined, _)| *predefined == name.as_str())
                {
                    return Ok(*value);
                }
                match self.macros.get(name.as_str()) {
                    Some(Some(_)) if self.expanding.contains(&name.as_str()) => Ok(0),
                    Some(Some(replacement)) => {
                        let mut expanding = self.expanding.to_vec();
                        expanding.push(name.as_str());
                        evaluate(replacement, self.macros, &expanding)
                            .map_err(|err| format!("`{name}` is `{replacement}`: {err}"))
                    }
                    Some(None) => Err(format!(
                        "`{name}` is a function-like macro, which the reader does not evaluate"
                    )),
                    None => Ok(0),
                }
            }
            _ => Err("an operand is missing".to_owned()),
        }
    }
}

/// Remove the `//` and `/* */` comments of one line.
fn strip_comments(line: &str) -> String {
    let mut out = String::new();
    let mut rest = line;
    loop {
        let line_comment = rest.find("//");
        let block = rest.find("/*");
        match (line_comment, block) {
            (Some(at), Some(open)) if at < open => {
                out.push_str(&rest[..at]);
                return out;
            }
            (Some(at), None) => {
                out.push_str(&rest[..at]);
                return out;
            }
            (_, Some(open)) => {
                out.push_str(&rest[..open]);
                out.push(' ');
                match rest[open + 2..].find("*/") {
                    Some(close) => rest = &rest[open + 2 + close + 2..],
                    None => return out,
                }
            }
            (None, None) => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

/// Split code into the declarations that end at a `;` outside every bracket, each with the
/// `//` or `/** */` comment lines directly above it. A blank line or a plain `/* */`
/// comment between a comment and the declaration detaches it.
fn statements(text: &str) -> Result<Vec<Statement>, String> {
    let mut out = Vec::new();
    let mut pending: Vec<String> = Vec::new();
    let mut current: Option<Statement> = None;
    let mut depth = 0usize;
    let mut line_has_content = false;
    let mut chars = text.char_indices().peekable();
    while let Some((at, c)) = chars.next() {
        let rest = &text[at..];
        if rest.starts_with("//") {
            let end = rest.find('\n').unwrap_or(rest.len());
            let comment = &rest[..end];
            match current.as_mut() {
                Some(statement) => {
                    statement.raw.push_str(comment);
                    statement.code.push(' ');
                }
                None => {
                    let body = comment.trim_start_matches('/');
                    pending.push(body.strip_prefix(' ').unwrap_or(body).trim_end().to_owned());
                }
            }
            line_has_content = true;
            skip(&mut chars, at + end);
            continue;
        }
        if let Some(after) = rest.strip_prefix("/*") {
            let end = after.find("*/").map_or(rest.len(), |close| close + 4);
            let comment = &rest[..end];
            match current.as_mut() {
                Some(statement) => {
                    statement.raw.push_str(comment);
                    statement.code.push(' ');
                }
                None if comment.starts_with("/**") => {
                    let inner = comment.trim_start_matches("/**").trim_end_matches("*/");
                    pending.extend(inner.lines().map(|line| {
                        let line = line.trim();
                        let line = line.strip_prefix('*').unwrap_or(line);
                        line.strip_prefix(' ').unwrap_or(line).trim_end().to_owned()
                    }));
                    while pending.first().is_some_and(String::is_empty) {
                        pending.remove(0);
                    }
                    while pending.last().is_some_and(String::is_empty) {
                        pending.pop();
                    }
                }
                None => pending.clear(),
            }
            line_has_content = true;
            skip(&mut chars, at + end);
            continue;
        }
        if c == '\n' {
            if current.is_none() && !line_has_content {
                pending.clear();
            }
            line_has_content = false;
        } else if !c.is_whitespace() {
            line_has_content = true;
        }
        let Some(statement) = current.as_mut() else {
            if !c.is_whitespace() {
                current = Some(Statement {
                    doc: std::mem::take(&mut pending),
                    raw: c.to_string(),
                    code: c.to_string(),
                });
                depth = usize::from(c == '{' || c == '(');
                if c == ';' {
                    current = None;
                }
            }
            continue;
        };
        statement.raw.push(c);
        statement.code.push(c);
        match c {
            '{' | '(' | '[' => depth += 1,
            '}' | ')' | ']' => depth = depth.saturating_sub(1),
            ';' if depth == 0 => {
                if let Some(done) = current.take() {
                    out.push(done);
                }
            }
            _ => {}
        }
    }
    match current {
        Some(statement) if !statement.code.trim().is_empty() => Err(format!(
            "an unterminated declaration: {}",
            squash(&statement.code)
        )),
        _ => Ok(out),
    }
}

/// Advance `chars` to byte offset `to`.
fn skip(chars: &mut std::iter::Peekable<std::str::CharIndices<'_>>, to: usize) {
    while chars.peek().is_some_and(|(at, _)| *at < to) {
        chars.next();
    }
}

/// Collapse every run of whitespace to one space and trim.
///
/// # Arguments
///
/// * `text` - the text, such as a declaration spread over several lines.
///
/// # Returns
///
/// The text on one line, its words separated by single spaces.
pub(crate) fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The byte range inside the first top-level `{ ... }` of `raw`, skipping comments.
fn body_span(raw: &str) -> Option<(usize, usize)> {
    let mut depth = 0usize;
    let mut open = None;
    let mut index = 0;
    while index < raw.len() {
        let rest = &raw[index..];
        if rest.starts_with("//") {
            index += rest.find('\n').unwrap_or(rest.len());
            continue;
        }
        if let Some(after) = rest.strip_prefix("/*") {
            index += after.find("*/").map_or(rest.len(), |close| close + 4);
            continue;
        }
        let c = rest.chars().next()?;
        if c == '{' {
            if depth == 0 {
                open = Some(index + 1);
            }
            depth += 1;
        } else if c == '}' {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return open.map(|start| (start, index));
            }
        }
        index += c.len_utf8();
    }
    None
}

/// Split `text` at each `separator` outside every bracket pair.
fn split_top(text: &str, separator: char) -> Vec<&str> {
    let mut parts = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (at, c) in text.char_indices() {
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth = depth.saturating_sub(1),
            c if c == separator && depth == 0 => {
                parts.push(&text[start..at]);
                start = at + c.len_utf8();
            }
            _ => {}
        }
    }
    parts.push(&text[start..]);
    parts
}

/// Add one declaration to `header`.
fn classify(header: &mut Header, statement: &Statement) -> Result<(), String> {
    let code = squash(statement.code.trim_end().trim_end_matches(';'));
    let words: Vec<&str> = code.split(' ').collect();
    let doc = statement.doc.clone();
    match words.as_slice() {
        ["typedef", "struct" | "enum" | "union", ..] | ["struct" | "enum" | "union", ..]
            if code.contains('{') =>
        {
            let keyword = if words.first() == Some(&"typedef") {
                words.get(1).copied().unwrap_or_default()
            } else {
                words.first().copied().unwrap_or_default()
            };
            let close = code.rfind('}').unwrap_or(code.len());
            let after = code[close..].trim_start_matches('}').trim();
            let name = if words.first() == Some(&"typedef") {
                after.to_owned()
            } else {
                words.get(1).map(|w| (*w).to_owned()).unwrap_or_default()
            };
            if !is_identifier(&name) {
                return Err(format!("cannot name the {keyword} in `{code}`"));
            }
            let (start, end) =
                body_span(&statement.raw).ok_or_else(|| format!("no body in `{code}`"))?;
            let body = &statement.raw[start..end];
            match keyword {
                "struct" => header.structs.push(Struct {
                    name,
                    fields: fields(body)?,
                    doc,
                }),
                "enum" => header.enums.push(Enum {
                    name,
                    underlying: None,
                    variants: variants(&squash(&strip_block_comments(body)))?,
                }),
                _ => return Err(format!("a union crosses no ABI here: `{code}`")),
            }
        }
        ["typedef", "struct", tag, name] if tag == name => header.opaque.push((*name).to_owned()),
        ["struct", name] => header.opaque.push((*name).to_owned()),
        ["typedef", ..] => {
            let (name, ty) = declaration(&code["typedef ".len()..])?;
            let name = name.ok_or_else(|| format!("a typedef without a name: `{code}`"))?;
            match ty {
                CType::Function(signature) => header.callbacks.push((name, *signature)),
                ty => header.aliases.push((name, ty)),
            }
        }
        _ if code.contains('(') => {
            let (name, ty) = declaration(&code)?;
            match (name, ty) {
                (Some(name), CType::Function(signature)) if !code.contains("(*") => {
                    header.functions.push(Function {
                        name,
                        signature: *signature,
                        doc,
                    })
                }
                _ => return Err(format!("cannot read the prototype `{code}`")),
            }
        }
        _ => return Err(format!("cannot read the declaration `{code}`")),
    }
    Ok(())
}

/// The text of a struct or enum body with every comment removed.
fn strip_block_comments(body: &str) -> String {
    body.lines()
        .map(strip_comments)
        .collect::<Vec<_>>()
        .join("\n")
}

/// The fields of a struct body, a declaration that names several (`uint32_t a, b`) giving
/// one field each.
fn fields(body: &str) -> Result<Vec<Param>, String> {
    let mut out = Vec::new();
    for statement in statements(body)? {
        let code = squash(statement.code.trim_end().trim_end_matches(';'));
        let mut declarators = split_top(&code, ',').into_iter();
        let first = declarators.next().unwrap_or_default();
        let (name, ty) = declaration(first)?;
        let name = name.ok_or_else(|| format!("a field without a name: `{code}`"))?;
        let base = match &ty {
            CType::Named { name, .. } => Some(name.clone()),
            CType::Array { element, .. } => Some(element.clone()),
            CType::Function(_) => None,
        };
        out.push(Param {
            name,
            ty,
            doc: statement.doc.clone(),
        });
        for more in declarators {
            let base = base
                .as_deref()
                .ok_or_else(|| format!("cannot read the field list `{code}`"))?;
            let (name, ty) = declaration(&format!("{base} {}", more.trim()))?;
            let name = name.ok_or_else(|| format!("a field without a name: `{code}`"))?;
            out.push(Param {
                name,
                ty,
                doc: statement.doc.clone(),
            });
        }
    }
    Ok(out)
}

/// The variants of an enum body with their values, an implicit value one more than the
/// previous one.
fn variants(body: &str) -> Result<Vec<(String, i128)>, String> {
    let mut out = Vec::new();
    let mut next: i128 = 0;
    for part in split_top(body, ',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        let (name, value) = match part.split_once('=') {
            Some((name, value)) => (name.trim(), integer(value.trim())?),
            None => (part, next),
        };
        if !is_identifier(name) {
            return Err(format!("cannot read the enum variant `{part}`"));
        }
        out.push((name.to_owned(), value));
        next = value
            .checked_add(1)
            .ok_or_else(|| format!("the enum value of {name} overflows"))?;
    }
    Ok(out)
}

/// A C integer literal: decimal or hexadecimal, optionally negative, with any `u` and `l`
/// suffixes.
fn integer(text: &str) -> Result<i128, String> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest.trim()),
        None => (false, text),
    };
    let digits = digits.trim_end_matches(['u', 'U', 'l', 'L']);
    let parsed = match digits
        .strip_prefix("0x")
        .or_else(|| digits.strip_prefix("0X"))
    {
        Some(hex) => i128::from_str_radix(hex, 16),
        None => digits.parse::<i128>(),
    }
    .map_err(|err| format!("cannot read the integer `{text}`: {err}"))?;
    Ok(if negative { -parsed } else { parsed })
}

/// Whether `text` is a C identifier.
fn is_identifier(text: &str) -> bool {
    let mut chars = text.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// The words that qualify a type or name its kind without being its name.
const QUALIFIERS: [&str; 6] = ["const", "volatile", "struct", "enum", "union", "restrict"];

/// Read one declaration: a parameter, a field, a typedef body or a prototype.
///
/// # Returns
///
/// The declared name, if the declaration names one, and its type. A prototype and a
/// function pointer both read as [`CType::Function`].
fn declaration(text: &str) -> Result<(Option<String>, CType), String> {
    let text = text.trim();
    if text.ends_with(')') {
        let params_open = matching_open(text, text.len() - 1)
            .ok_or_else(|| format!("unbalanced parentheses in `{text}`"))?;
        let before = text[..params_open].trim_end();
        let params = parameters(&text[params_open + 1..text.len() - 1])?;
        if let Some(inner) = before
            .strip_suffix(')')
            .and_then(|b| b.rfind("(*").map(|at| (at, b)))
        {
            let (at, b) = inner;
            let name = b[at + 2..].trim();
            let returns = declaration(&b[..at])?.1;
            let name = (!name.is_empty()).then(|| name.to_owned());
            return Ok((
                name,
                CType::Function(Box::new(Signature { returns, params })),
            ));
        }
        let name_start = before
            .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .map_or(0, |at| at + 1);
        let name = &before[name_start..];
        if !is_identifier(name) {
            return Err(format!("cannot name the function in `{text}`"));
        }
        let returns = type_only(&before[..name_start])?;
        return Ok((
            Some(name.to_owned()),
            CType::Function(Box::new(Signature { returns, params })),
        ));
    }

    let (text, len) = match text.strip_suffix(']').and_then(|t| t.rsplit_once('[')) {
        Some((head, len)) => (
            head.trim_end(),
            Some(
                len.trim()
                    .parse::<usize>()
                    .map_err(|err| format!("cannot read the array length in `{text}`: {err}"))?,
            ),
        ),
        None => (text, None),
    };
    let tokens = tokens(text);
    let last_is_name = tokens.last().is_some_and(|last| {
        is_identifier(last)
            && !QUALIFIERS.contains(&last.as_str())
            && tokens[..tokens.len() - 1]
                .iter()
                .any(|token| is_identifier(token) && !QUALIFIERS.contains(&token.as_str()))
    });
    let (name, type_tokens) = if last_is_name {
        (tokens.last().cloned(), &tokens[..tokens.len() - 1])
    } else {
        (None, &tokens[..])
    };
    let ty = named(type_tokens, text)?;
    match (len, ty) {
        (None, ty) => Ok((name, ty)),
        (
            Some(len),
            CType::Named {
                name: element,
                pointers: 0,
            },
        ) => Ok((name, CType::Array { element, len })),
        (Some(_), _) => Err(format!(
            "an array of pointers crosses no ABI here: `{text}`"
        )),
    }
}

/// The index of the `(` that the `)` at `close` closes.
fn matching_open(text: &str, close: usize) -> Option<usize> {
    let mut depth = 0usize;
    for (at, c) in text[..=close].char_indices().rev() {
        match c {
            ')' => depth += 1,
            '(' => {
                depth -= 1;
                if depth == 0 {
                    return Some(at);
                }
            }
            _ => {}
        }
    }
    None
}

/// The parameters of a parameter list; `void` alone is none.
fn parameters(text: &str) -> Result<Vec<Param>, String> {
    let text = text.trim();
    if text.is_empty() || text == "void" {
        return Ok(Vec::new());
    }
    split_top(text, ',')
        .into_iter()
        .enumerate()
        .map(|(index, part)| {
            let (name, ty) = declaration(part)?;
            Ok(Param {
                name: name.unwrap_or_else(|| format!("arg{index}")),
                ty,
                doc: Vec::new(),
            })
        })
        .collect()
}

/// A type with no declared name.
fn type_only(text: &str) -> Result<CType, String> {
    named(&tokens(text), text)
}

/// The type the tokens of a declaration spell, its qualifiers dropped.
fn named(tokens: &[String], text: &str) -> Result<CType, String> {
    let pointers = tokens.iter().filter(|token| *token == "*").count();
    let words: Vec<&str> = tokens
        .iter()
        .map(String::as_str)
        .filter(|token| *token != "*" && !QUALIFIERS.contains(token))
        .collect();
    if words.is_empty() || words.iter().any(|word| !is_identifier(word)) {
        return Err(format!("cannot read the type in `{text}`"));
    }
    Ok(CType::Named {
        name: words.join(" "),
        pointers,
    })
}

/// Split a declaration into identifiers and `*`.
fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() || c == '_' {
            word.push(c);
            continue;
        }
        if !word.is_empty() {
            out.push(std::mem::take(&mut word));
        }
        if !c.is_whitespace() {
            out.push(c.to_string());
        }
    }
    if !word.is_empty() {
        out.push(word);
    }
    out
}

/// The C# integer or floating-point type of the same width and signedness.
///
/// # Arguments
///
/// * `name` - a C type name.
///
/// # Returns
///
/// The C# keyword, or `None` for a type that is not a C arithmetic type.
pub(crate) fn primitive(name: &str) -> Option<&'static str> {
    Some(match name {
        "uint8_t" | "unsigned char" | "char" => "byte",
        "int8_t" | "signed char" => "sbyte",
        "uint16_t" | "unsigned short" => "ushort",
        "int16_t" | "short" => "short",
        "uint32_t" | "unsigned int" | "unsigned" => "uint",
        "int32_t" | "int" => "int",
        "uint64_t" | "unsigned long long" => "ulong",
        "int64_t" | "long long" => "long",
        "uintptr_t" | "size_t" => "nuint",
        "intptr_t" | "ptrdiff_t" => "nint",
        "float" => "float",
        "double" => "double",
        _ => return None,
    })
}

impl Header {
    fn is_opaque(&self, name: &str) -> bool {
        self.opaque.iter().any(|opaque| opaque == name)
    }

    fn is_struct(&self, name: &str) -> bool {
        self.structs.iter().any(|s| s.name == name)
    }

    fn is_enum(&self, name: &str) -> bool {
        self.enums.iter().any(|e| e.name == name)
    }

    fn callback(&self, name: &str) -> Option<&Signature> {
        self.callbacks
            .iter()
            .find(|(callback, _)| callback == name)
            .map(|(_, signature)| signature)
    }

    fn alias(&self, name: &str) -> Option<&CType> {
        self.aliases
            .iter()
            .find(|(alias, _)| alias == name)
            .map(|(_, ty)| ty)
    }

    /// The C# type the mirror writes for a C type.
    ///
    /// # Arguments
    ///
    /// * `ty` - the C type.
    /// * `position` - where it appears.
    ///
    /// # Returns
    ///
    /// The C# spelling; for an array, the element type of its fixed buffer.
    ///
    /// # Errors
    ///
    /// A type the map has no entry for, such as an opaque struct by value or `void` as a
    /// parameter.
    pub(crate) fn cs_type(&self, ty: &CType, position: Position) -> Result<String, String> {
        match ty {
            CType::Function(signature) => self.cs_function_pointer(signature),
            CType::Array { element, .. } => primitive(element)
                .filter(|p| !matches!(*p, "nuint" | "nint"))
                .map(str::to_owned)
                .ok_or_else(|| format!("a fixed buffer of `{element}` has no C# spelling")),
            CType::Named { name, pointers } => {
                if let Some(target) = self.alias(name) {
                    return match target {
                        CType::Named {
                            name: base,
                            pointers: inner,
                        } => self.cs_type(
                            &CType::Named {
                                name: base.clone(),
                                pointers: inner + pointers,
                            },
                            position,
                        ),
                        _ if *pointers == 0 => self.cs_type(target, position),
                        _ => Err(format!("a pointer to `{name}` has no C# spelling")),
                    };
                }
                if let Some(signature) = self.callback(name) {
                    return if *pointers == 0 {
                        self.cs_function_pointer(signature)
                    } else if position == Position::Return {
                        Ok("nint".to_owned())
                    } else {
                        Err(format!(
                            "a pointer to the function type `{name}` has no C# spelling"
                        ))
                    };
                }
                if *pointers == 0 {
                    return match name.as_str() {
                        "void" if position == Position::Return => Ok("void".to_owned()),
                        "void" => Err("`void` is not a parameter or field type".to_owned()),
                        _ if self.is_struct(name) || self.is_enum(name) => Ok(name.clone()),
                        _ if self.is_opaque(name) => {
                            Err(format!("the opaque `{name}` crosses only behind a pointer"))
                        }
                        _ => primitive(name)
                            .map(str::to_owned)
                            .ok_or_else(|| format!("`{name}` has no C# spelling")),
                    };
                }
                if position == Position::Return {
                    return Ok("nint".to_owned());
                }
                let stars = "*".repeat(pointers - 1);
                if self.is_opaque(name) {
                    return Ok(format!("nint{stars}"));
                }
                let pointee = match name.as_str() {
                    "void" => "void".to_owned(),
                    _ if self.is_struct(name) || self.is_enum(name) => name.clone(),
                    _ => primitive(name)
                        .map(str::to_owned)
                        .ok_or_else(|| format!("`{name}` has no C# spelling"))?,
                };
                Ok(format!("{pointee}*{stars}"))
            }
        }
    }

    fn cs_function_pointer(&self, signature: &Signature) -> Result<String, String> {
        let mut parts = Vec::new();
        for param in &signature.params {
            parts.push(self.cs_type(&param.ty, Position::Param)?);
        }
        parts.push(self.cs_type(&signature.returns, Position::Return)?);
        Ok(format!("delegate* unmanaged<{}>", parts.join(", ")))
    }
}

/// A C identifier as a C# name, escaped with `@` when it is a C# keyword.
///
/// # Arguments
///
/// * `name` - the C identifier.
///
/// # Returns
///
/// The C# name.
pub(crate) fn cs_name(name: &str) -> String {
    if CS_KEYWORDS.contains(&name) {
        format!("@{name}")
    } else {
        name.to_owned()
    }
}

/// Escape text for an XML documentation comment.
fn xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Write a documentation comment: the first paragraph of `doc` as the summary and the rest
/// as remarks, or `fallback` as the summary when `doc` is empty.
fn xml_doc(out: &mut String, indent: &str, doc: &[String], fallback: &str) {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in doc {
        let line = line.trim();
        if line.is_empty() {
            if !current.is_empty() {
                paragraphs.push(current.join(" "));
                current.clear();
            }
        } else {
            current.push(line.trim_start_matches("# "));
        }
    }
    if !current.is_empty() {
        paragraphs.push(current.join(" "));
    }
    let mut paragraphs = paragraphs.into_iter();
    let summary = paragraphs
        .next()
        .map_or_else(|| fallback.to_owned(), |first| xml(&first));
    out.push_str(&format!("{indent}/// <summary>{summary}</summary>\n"));
    let remarks: Vec<String> = paragraphs.collect();
    if !remarks.is_empty() {
        out.push_str(&format!("{indent}/// <remarks>\n"));
        for paragraph in remarks {
            out.push_str(&format!("{indent}/// <para>{}</para>\n", xml(&paragraph)));
        }
        out.push_str(&format!("{indent}/// </remarks>\n"));
    }
}

/// Render the .NET declarations of a header.
///
/// # Arguments
///
/// * `header` - the parsed header.
///
/// # Returns
///
/// The text of `NativeMethods.g.cs`.
///
/// # Errors
///
/// A type the C-to-C# map has no entry for, named with the declaration that uses it.
pub(crate) fn render(header: &Header) -> Result<String, String> {
    let mut out = String::from(
        "// <auto-generated>\n\
         // Generated from crates/zero-ffi/include/zero.h by `cargo xtask ffi-mirror --write`.\n\
         // Do not edit by hand.\n\
         // </auto-generated>\n\n\
         using System.Runtime.InteropServices;\n\n\
         namespace ZeroServer.Native.Interop;\n",
    );
    for item in &header.structs {
        out.push('\n');
        xml_doc(
            &mut out,
            "",
            &item.doc,
            &format!("The <c>{}</c> struct of <c>zero.h</c>.", item.name),
        );
        out.push_str("[StructLayout(LayoutKind.Sequential)]\n");
        out.push_str(&format!("public unsafe struct {}\n{{\n", item.name));
        for (index, field) in item.fields.iter().enumerate() {
            if index > 0 {
                out.push('\n');
            }
            xml_doc(
                &mut out,
                "    ",
                &field.doc,
                &format!("The <c>{}</c> field.", field.name),
            );
            let ty = header
                .cs_type(&field.ty, Position::Field)
                .map_err(|err| format!("{}.{}: {err}", item.name, field.name))?;
            let line = match &field.ty {
                CType::Array { len, .. } => {
                    format!("    public fixed {ty} {}[{len}];\n", cs_name(&field.name))
                }
                _ => format!("    public {ty} {};\n", cs_name(&field.name)),
            };
            out.push_str(&line);
        }
        out.push_str("}\n");
    }
    out.push_str("\npublic static unsafe partial class NativeMethods\n{\n");
    for (index, function) in header.functions.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        xml_doc(
            &mut out,
            "    ",
            &function.doc,
            &format!("The <c>{}</c> export of <c>zero.h</c>.", function.name),
        );
        out.push_str("    [LibraryImport(Library)]\n");
        if SUPPRESS_GC_TRANSITION.contains(&function.name.as_str()) {
            out.push_str("    [SuppressGCTransition]\n");
        }
        let returns = header
            .cs_type(&function.signature.returns, Position::Return)
            .map_err(|err| format!("{}: {err}", function.name))?;
        let mut params = Vec::new();
        for param in &function.signature.params {
            let ty = header
                .cs_type(&param.ty, Position::Param)
                .map_err(|err| format!("{} ({}): {err}", function.name, param.name))?;
            params.push(format!("{ty} {}", cs_name(&param.name)));
        }
        out.push_str(&format!(
            "    public static partial {returns} {}({});\n",
            function.name,
            params.join(", ")
        ));
    }
    out.push_str("}\n");
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A header in the shape cbindgen writes with the workspace's configuration
    /// (`style = "type"`, c99 documentation, `cpp_compat`): untagged struct and enum
    /// typedefs, opaque handles, a status enum, function pointer typedefs, a C++ guard and
    /// prototypes wrapped across lines. One field list declares two fields, which cbindgen
    /// never writes and a hand-written header may.
    ///
    /// @see <https://github.com/mozilla/cbindgen/blob/v0.29.4/docs.md#cbindgentoml>
    pub(crate) const SAMPLE_HEADER: &str = r#"/* zero-server C ABI.
 *
 * The rules. */

#pragma once

/* Generated by cbindgen from crates/zero-ffi. Do not edit by hand. */

#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

// The version of the C ABI.
#define ZERO_ABI_VERSION 1

#define ZERO_NONE UINT64_MAX

#define ZERO_ID_MAX 9007199254740991ull

// The result of a call.
typedef enum {
  ZeroStatus_Ok = 0,
  ZeroStatus_Protocol = 1,
  ZeroStatus_Io,
  ZeroStatus_InvalidArgument = 9,
} ZeroStatus;

// An owned string.
typedef struct ZeroString ZeroString;

typedef struct ZeroBuffer ZeroBuffer;

// A borrowed byte range.
typedef struct {
  // The first byte.
  const uint8_t *ptr;
  // The length.
  uintptr_t len;
} ZeroBytes;

typedef struct {
  uint32_t size;
  uint8_t family, secure;
  uint8_t reserved[7];
  ZeroBytes name;
  void *ctx;
  int32_t (*handle)(void *ctx, uint32_t route, uint64_t slot);
} ZeroPeer;

typedef uint32_t (*ZeroPluginAbiVersionFn)(void);

#ifdef __cplusplus
extern "C" {
#endif // __cplusplus

// Returns the version of the zero-server core.
//
// # Returns
//
// A pointer to a static string.
const char *zero_version(void);

uint32_t zero_abi_version(void);

const uint8_t *zero_buffer_data(const ZeroBuffer *buffer);

void zero_string_free(ZeroString *string);

ZeroStatus zero_app_route(uint64_t app,
                          uint32_t kind,
                          uint8_t method,
                          const uint8_t *pattern,
                          uintptr_t pattern_len,
                          uint32_t *route_out);

ZeroStatus zero_conformance_case(const uint8_t *section,
                                 uintptr_t section_len,
                                 ZeroBuffer **result_out);

ZeroStatus zero_req_view(uint64_t slot, ZeroPeer *view_out);

ZeroStatus zero_plugin(ZeroPluginAbiVersionFn version);

#ifdef __cplusplus
}  // extern "C"
#endif  // __cplusplus
"#;

    fn named(name: &str, pointers: usize) -> CType {
        CType::Named {
            name: name.to_owned(),
            pointers,
        }
    }

    #[test]
    fn the_header_reader_reads_every_kind_of_declaration_cbindgen_writes() {
        let header = parse_header(SAMPLE_HEADER).unwrap();
        assert_eq!(header.opaque, ["ZeroString", "ZeroBuffer"]);
        assert_eq!(
            header.enums,
            [Enum {
                name: "ZeroStatus".to_owned(),
                underlying: None,
                variants: vec![
                    ("ZeroStatus_Ok".to_owned(), 0),
                    ("ZeroStatus_Protocol".to_owned(), 1),
                    ("ZeroStatus_Io".to_owned(), 2),
                    ("ZeroStatus_InvalidArgument".to_owned(), 9),
                ],
            }]
        );
        let bytes = &header.structs[0];
        assert_eq!(bytes.name, "ZeroBytes");
        assert_eq!(bytes.doc, ["A borrowed byte range."]);
        assert_eq!(bytes.fields[0].name, "ptr");
        assert_eq!(bytes.fields[0].ty, named("uint8_t", 1));
        assert_eq!(bytes.fields[0].doc, ["The first byte."]);
        assert_eq!(bytes.fields[1].ty, named("uintptr_t", 0));
        let peer = &header.structs[1];
        let names: Vec<&str> = peer.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            names,
            ["size", "family", "secure", "reserved", "name", "ctx", "handle"]
        );
        assert_eq!(peer.fields[2].ty, named("uint8_t", 0));
        assert_eq!(
            peer.fields[3].ty,
            CType::Array {
                element: "uint8_t".to_owned(),
                len: 7
            }
        );
        assert!(matches!(&peer.fields[6].ty, CType::Function(sig) if sig.params.len() == 3));
        assert_eq!(header.callbacks.len(), 1);
        assert_eq!(header.callbacks[0].0, "ZeroPluginAbiVersionFn");

        let functions: Vec<&str> = header.functions.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(
            functions,
            [
                "zero_version",
                "zero_abi_version",
                "zero_buffer_data",
                "zero_string_free",
                "zero_app_route",
                "zero_conformance_case",
                "zero_req_view",
                "zero_plugin",
            ]
        );
        let version = &header.functions[0];
        assert_eq!(version.signature.returns, named("char", 1));
        assert!(version.signature.params.is_empty());
        assert_eq!(
            version.doc,
            [
                "Returns the version of the zero-server core.",
                "",
                "# Returns",
                "",
                "A pointer to a static string."
            ]
        );
        assert!(header.functions[1].doc.is_empty());
        let route = &header.functions[4];
        assert_eq!(route.signature.params.len(), 6);
        assert_eq!(route.signature.params[3].name, "pattern");
        assert_eq!(route.signature.params[3].ty, named("uint8_t", 1));
        assert_eq!(
            header.functions[5].signature.params[2].ty,
            named("ZeroBuffer", 2)
        );
    }

    #[test]
    fn a_cplusplus_block_never_reaches_the_reader_and_a_c_only_block_does() {
        let header = parse_header(concat!(
            "#ifdef __cplusplus\nnamespace zero { struct X; }\n#endif\n",
            "#ifndef __cplusplus\ntypedef uint32_t Mode;\n#else\nenum class Mode : uint32_t;\n#endif\n",
            "enum Mode {\n  Mode_A,\n  Mode_B,\n};\n",
        ))
        .unwrap();
        assert!(header.opaque.is_empty());
        assert_eq!(header.enums[0].underlying.as_deref(), Some("uint32_t"));
        assert_eq!(header.enums[0].variants[1], ("Mode_B".to_owned(), 1));
        assert!(header.aliases.is_empty());
    }

    /// An excerpt of what cbindgen 0.29.4 writes when `cpp_compat` is set: enums with a
    /// fixed representation behind C++ and C23 guards, untagged enum and struct typedefs,
    /// and opaque handles.
    ///
    /// @see <https://github.com/mozilla/cbindgen/blob/v0.29.4/tests/expectations/enum.compat.c>
    const COMPAT: &str = r#"#if 0
''' '
#endif

#ifdef __cplusplus
template <typename T>
using Box = T*;
#endif

#if 0
' '''
#endif

enum A
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : uint64_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  a1 = 0,
  a2 = 2,
  a3,
  a4 = 5,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum A A;
#else
typedef uint64_t A;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

typedef enum {
  l1,
  l2,
  l3,
  l4,
} L;

enum M
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : int8_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  m1 = -1,
  m2 = 0,
  m3 = 1,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum M M;
#else
typedef int8_t M;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

typedef struct J J;

typedef struct K K;

typedef struct Opaque Opaque;

enum G_Tag
#if defined(__cplusplus) || __STDC_VERSION__ >= 202311L
  : uint8_t
#endif // defined(__cplusplus) || __STDC_VERSION__ >= 202311L
 {
  Foo,
  Bar,
  Baz,
};
#ifndef __cplusplus
#if __STDC_VERSION__ >= 202311L
typedef enum G_Tag G_Tag;
#else
typedef uint8_t G_Tag;
#endif // __STDC_VERSION__ >= 202311L
#endif // __cplusplus

typedef struct {
  G_Tag tag;
  uint8_t x;
  int16_t y;
} Bar_Body;
"#;

    fn variants(items: &[(&str, i128)]) -> Vec<(String, i128)> {
        items
            .iter()
            .map(|(name, value)| ((*name).to_owned(), *value))
            .collect()
    }

    #[test]
    fn the_compat_shapes_of_cbindgen_read_as_a_c17_compiler_sees_them() {
        let header = parse_header(COMPAT).unwrap();
        let enum_of = |name: &str, underlying: Option<&str>, items: &[(&str, i128)]| Enum {
            name: name.to_owned(),
            underlying: underlying.map(str::to_owned),
            variants: variants(items),
        };
        assert_eq!(
            header.enums,
            [
                enum_of(
                    "A",
                    Some("uint64_t"),
                    &[("a1", 0), ("a2", 2), ("a3", 3), ("a4", 5)]
                ),
                enum_of("L", None, &[("l1", 0), ("l2", 1), ("l3", 2), ("l4", 3)]),
                enum_of("M", Some("int8_t"), &[("m1", -1), ("m2", 0), ("m3", 1)]),
                enum_of(
                    "G_Tag",
                    Some("uint8_t"),
                    &[("Foo", 0), ("Bar", 1), ("Baz", 2)]
                ),
            ]
        );
        assert_eq!(header.opaque, ["J", "K", "Opaque"]);
        assert_eq!(header.structs.len(), 1);
        let body = &header.structs[0];
        assert_eq!(body.name, "Bar_Body");
        let fields: Vec<(&str, &CType)> = body
            .fields
            .iter()
            .map(|field| (field.name.as_str(), &field.ty))
            .collect();
        assert_eq!(
            fields,
            [
                ("tag", &named("G_Tag", 0)),
                ("x", &named("uint8_t", 0)),
                ("y", &named("int16_t", 0)),
            ]
        );
        assert!(header.aliases.is_empty());
        assert!(header.functions.is_empty());
    }

    /// An excerpt of what cbindgen writes for items behind a `[defines]` entry: the
    /// conditions test macros the header itself may not define, a condition removes an
    /// enum variant before an implicitly numbered one, and another removes a struct field.
    ///
    /// @see <https://github.com/mozilla/cbindgen/blob/v0.29.4/tests/expectations/cfg.c>
    const DEFINES: &str = r#"#if 0
DEF PLATFORM_UNIX = 0
DEF PLATFORM_WIN = 0
DEF X11 = 0
DEF M_32 = 0
#endif
#define PLATFORM_UNIX 1


#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
  uint8_t _0;
} Flags;
/**
 * none
 */
#define Flags_NONE (Flags){ ._0 = (uint8_t)0 }
#if defined(PLATFORM_WIN)
#define Flags_A (Flags){ ._0 = (uint8_t)(1 << 0) }
#endif
#if defined(PLATFORM_UNIX)
#define Flags_A (Flags){ ._0 = (uint8_t)(1 << 1) }
#endif

#if (defined(PLATFORM_UNIX) && defined(X11))
typedef struct {
  FooType ty;
  Flags flags;
  int32_t x;
  float y;
} FooHandle;
#endif

enum C_Tag
#if __STDC_VERSION__ >= 202311L
  : uint8_t
#endif // __STDC_VERSION__ >= 202311L
 {
  C1,
  C2,
#if defined(PLATFORM_WIN)
  C3,
#endif
#if defined(PLATFORM_UNIX)
  C5,
#endif
};
#if __STDC_VERSION__ >= 202311L
typedef enum C_Tag C_Tag;
#else
typedef uint8_t C_Tag;
#endif // __STDC_VERSION__ >= 202311L

#if defined(PLATFORM_UNIX)
typedef struct {
  C_Tag tag;
  int32_t int_;
} C5_Body;
#endif

typedef struct {
#if defined(X11)
  int32_t field
#endif
  ;
} ConditionalField;
#define ConditionalField_ZERO (ConditionalField){ .field = 0 }
#define ConditionalField_ONE (ConditionalField){ .field = 1 }

typedef struct {
  int32_t x;
  float y;
} Normal;

#if (defined(PLATFORM_UNIX) && defined(X11))
void root(FooHandle a, C c);
#endif

#if (defined(PLATFORM_WIN) || defined(M_32))
void root(BarHandle a, C c);
#endif

void cond(ConditionalField a);

#if defined(PLATFORM_WIN)
extern int32_t foo(void);
#endif

#if defined(PLATFORM_WIN)
extern void bar(Normal a);
#endif
"#;

    #[test]
    fn the_defines_shape_of_cbindgen_reads_the_one_configuration_a_c17_compiler_sees() {
        let header = parse_header(DEFINES).unwrap();
        assert_eq!(
            header.enums,
            [Enum {
                name: "C_Tag".to_owned(),
                underlying: Some("uint8_t".to_owned()),
                variants: variants(&[("C1", 0), ("C2", 1), ("C5", 2)]),
            }]
        );
        let structs: Vec<(&str, usize)> = header
            .structs
            .iter()
            .map(|item| (item.name.as_str(), item.fields.len()))
            .collect();
        assert_eq!(
            structs,
            [
                ("Flags", 1),
                ("C5_Body", 2),
                ("ConditionalField", 0),
                ("Normal", 2)
            ]
        );
        let functions: Vec<&str> = header.functions.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(functions, ["cond"]);
        let rendered = render(&header).unwrap();
        assert_eq!(rendered.matches("[LibraryImport(Library)]").count(), 1);
        assert!(rendered.contains("    public static partial void cond(ConditionalField a);\n"));
    }

    #[test]
    fn conditions_are_evaluated_as_a_c17_compiler_evaluates_them() {
        let none = Macros::new();
        let eval = |text: &str| condition(text, &none);
        assert_eq!(eval("0"), Ok(false));
        assert_eq!(eval("1"), Ok(true));
        assert_eq!(eval("__STDC_VERSION__ >= 202311L"), Ok(false));
        assert_eq!(eval("__STDC_VERSION__ >= 201710L"), Ok(true));
        assert_eq!(eval("__STDC__ && __STDC_HOSTED__"), Ok(true));
        assert_eq!(
            eval("defined(__cplusplus) || __STDC_VERSION__ >= 202311L"),
            Ok(false)
        );
        assert_eq!(eval("!defined __cplusplus"), Ok(true));
        assert_eq!(eval("defined(PLATFORM_WIN)"), Ok(false));
        assert_eq!(eval("!defined(PLATFORM_WIN)"), Ok(true));
        assert_eq!(eval("defined(PLATFORM_WIN) || 1"), Ok(true));
        assert_eq!(eval("UNDEFINED"), Ok(false));
        assert_eq!(eval("UNDEFINED == 0"), Ok(true));
        for unreadable in ["(1", "1 + 1", "", "1 1", "defined", "'a'"] {
            assert!(eval(unreadable).is_err(), "{unreadable:?}");
        }
        let mut macros = Macros::new();
        macros.insert("EMPTY".to_owned(), Some(String::new()));
        macros.insert("ONE".to_owned(), Some("1".to_owned()));
        macros.insert("ALIAS".to_owned(), Some("ONE".to_owned()));
        macros.insert("SELF".to_owned(), Some("SELF".to_owned()));
        macros.insert("CALL".to_owned(), None);
        assert_eq!(condition("defined(EMPTY)", &macros), Ok(true));
        assert!(condition("EMPTY", &macros).is_err());
        assert_eq!(condition("ONE", &macros), Ok(true));
        assert_eq!(condition("ALIAS == 1", &macros), Ok(true));
        assert_eq!(condition("SELF", &macros), Ok(false));
        assert_eq!(condition("defined CALL", &macros), Ok(true));
        assert!(condition("CALL", &macros).is_err());
    }

    #[test]
    fn only_the_groups_a_c17_compiler_processes_are_read() {
        let header = parse_header(concat!(
            "#ifdef SOMETHING\nvoid zero_a(void);\n#else\nvoid zero_b(void);\n#endif\n",
            "#if 0\nvoid zero_c(void);\n#elif 1\nvoid zero_d(void);\n#elif 1\nvoid zero_e(void);\n#else\nvoid zero_f(void);\n#endif\n",
            "#define ZERO_FEATURE\n#ifdef ZERO_FEATURE\nvoid zero_g(void);\n#endif\n",
            "#undef ZERO_FEATURE\n#if defined(ZERO_FEATURE)\nvoid zero_h(void);\n#endif\n",
            "#if 0\n#if (unreadable\n#error skipped\n#endif\nvoid zero_i(void);\n#else\nvoid zero_j(void);\n#endif\n",
            "#define ZERO_\\\nSPLICED 1\n#if ZERO_SPLICED\nvoid zero_k(void);\n#endif\n",
        ))
        .unwrap();
        let names: Vec<&str> = header.functions.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["zero_b", "zero_d", "zero_g", "zero_j", "zero_k"]);

        let err = parse_header("void zero_a(void);\n#if 1 + 1\n#endif\n").unwrap_err();
        assert!(err.starts_with("line 2: #if 1 + 1: "), "{err}");
        let err = parse_header("#ifndef __cplusplus\n#error C only\n#endif\n").unwrap_err();
        assert!(err.starts_with("line 2: #error C only: "), "{err}");
        let err = parse_header("#endif\n").unwrap_err();
        assert!(err.contains("no #if is open"), "{err}");
        let err = parse_header("#ifdef\n#endif\n").unwrap_err();
        assert!(err.contains("one macro name"), "{err}");
    }

    #[test]
    fn a_comment_separated_by_a_blank_line_documents_nothing() {
        let header = parse_header("// File notes.\n\nvoid zero_a(void);\n").unwrap();
        assert!(header.functions[0].doc.is_empty());
    }

    #[test]
    fn an_unterminated_declaration_is_an_error() {
        let err = parse_header("int x").unwrap_err();
        assert_eq!(err, "an unterminated declaration: int x");
    }

    #[test]
    fn a_declaration_the_reader_does_not_recognize_is_an_error() {
        let err = parse_header("int x;\n").unwrap_err();
        assert_eq!(err, "cannot read the declaration `int x`");
        let err = parse_header("int (*zero_f)(void);\n").unwrap_err();
        assert_eq!(err, "cannot read the prototype `int (*zero_f)(void)`");
        let err = parse_header("union U { int a; } U;\n").unwrap_err();
        assert!(err.starts_with("a union crosses no ABI here"), "{err}");
        let err = parse_header("#ifdef A\nvoid f(void);\n").unwrap_err();
        assert_eq!(err, "an #if is never closed");
        assert!(parse_header("void zero_a(void);\n").is_ok());
    }

    #[test]
    fn the_type_map_follows_the_rules_of_the_mirror() {
        let header = parse_header(SAMPLE_HEADER).unwrap();
        let cs = |ty: CType, position| header.cs_type(&ty, position).unwrap();
        assert_eq!(cs(named("uint64_t", 0), Position::Param), "ulong");
        assert_eq!(cs(named("uintptr_t", 0), Position::Param), "nuint");
        assert_eq!(cs(named("int32_t", 0), Position::Field), "int");
        assert_eq!(cs(named("uint8_t", 1), Position::Param), "byte*");
        assert_eq!(cs(named("char", 1), Position::Param), "byte*");
        assert_eq!(cs(named("ZeroBytes", 1), Position::Param), "ZeroBytes*");
        assert_eq!(cs(named("ZeroStatus", 0), Position::Return), "ZeroStatus");
        assert_eq!(cs(named("ZeroStatus", 1), Position::Param), "ZeroStatus*");
        assert_eq!(cs(named("ZeroBuffer", 1), Position::Param), "nint");
        assert_eq!(cs(named("ZeroBuffer", 2), Position::Param), "nint*");
        assert_eq!(cs(named("char", 1), Position::Return), "nint");
        assert_eq!(cs(named("uint8_t", 1), Position::Return), "nint");
        assert_eq!(cs(named("void", 1), Position::Field), "void*");
        assert_eq!(cs(named("void", 0), Position::Return), "void");
        assert_eq!(
            cs(named("ZeroPluginAbiVersionFn", 0), Position::Field),
            "delegate* unmanaged<uint>"
        );
        assert!(header
            .cs_type(&named("ZeroBuffer", 0), Position::Param)
            .is_err());
        assert!(header.cs_type(&named("void", 0), Position::Param).is_err());
        assert!(header.cs_type(&named("bool", 0), Position::Param).is_err());
        assert_eq!(cs_name("string"), "@string");
        assert_eq!(cs_name("slot"), "slot");
    }

    #[test]
    fn the_mirror_of_the_sample_header_declares_every_struct_and_import() {
        let rendered = render(&parse_header(SAMPLE_HEADER).unwrap()).unwrap();
        for expected in [
            "// Generated from crates/zero-ffi/include/zero.h by `cargo xtask ffi-mirror --write`.\n",
            "namespace ZeroServer.Native.Interop;\n",
            "/// <summary>A borrowed byte range.</summary>\n[StructLayout(LayoutKind.Sequential)]\npublic unsafe struct ZeroBytes\n{\n    /// <summary>The first byte.</summary>\n    public byte* ptr;\n\n    /// <summary>The length.</summary>\n    public nuint len;\n}\n",
            "    public byte family;\n",
            "    public byte secure;\n",
            "    public fixed byte reserved[7];\n",
            "    public ZeroBytes name;\n",
            "    public void* ctx;\n",
            "    public delegate* unmanaged<void*, uint, ulong, int> handle;\n",
            "public static unsafe partial class NativeMethods\n{\n",
            "    /// <summary>Returns the version of the zero-server core.</summary>\n    /// <remarks>\n    /// <para>Returns</para>\n    /// <para>A pointer to a static string.</para>\n    /// </remarks>\n    [LibraryImport(Library)]\n    public static partial nint zero_version();\n",
            "    [LibraryImport(Library)]\n    [SuppressGCTransition]\n    public static partial uint zero_abi_version();\n",
            "    public static partial nint zero_buffer_data(nint buffer);\n",
            "    public static partial void zero_string_free(nint @string);\n",
            "    public static partial ZeroStatus zero_app_route(ulong app, uint kind, byte method, byte* pattern, nuint pattern_len, uint* route_out);\n",
            "    public static partial ZeroStatus zero_conformance_case(byte* section, nuint section_len, nint* result_out);\n",
            "    [SuppressGCTransition]\n    public static partial ZeroStatus zero_req_view(ulong slot, ZeroPeer* view_out);\n",
            "    public static partial ZeroStatus zero_plugin(delegate* unmanaged<uint> version);\n",
        ] {
            assert!(rendered.contains(expected), "missing {expected:?} in\n{rendered}");
        }
        assert!(!rendered.contains("enum ZeroStatus"));
        assert!(rendered.contains(
            "/// <summary>The <c>zero_abi_version</c> export of <c>zero.h</c>.</summary>"
        ));
        assert!(rendered.ends_with("}\n"));
        assert!(!rendered.contains('\t'));
    }

    #[test]
    fn a_type_without_a_csharp_spelling_names_its_declaration() {
        let header = parse_header("typedef struct H H;\nvoid zero_a(H h);\n").unwrap();
        let err = render(&header).unwrap_err();
        assert!(err.contains("zero_a (h)"), "{err}");
    }

    #[test]
    fn the_committed_header_reads_and_renders() {
        let root = crate::docs::repo_root();
        let text = fs::read_to_string(root.join(HEADER)).unwrap();
        let header = parse_header(&text).unwrap();
        assert!(header
            .functions
            .iter()
            .any(|function| function.name == "zero_version"));
        render(&header).unwrap();
    }
}
