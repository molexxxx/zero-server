//! The .NET declarations against the C header. `cargo xtask surface --check` reads every C#
//! file of `bindings/dotnet/src/ZeroServer.Native/Interop/` and holds it to
//! `crates/zero-ffi/include/zero.h`:
//!
//! - every `[LibraryImport]` or `[DllImport]` names a prototype the header declares, and
//!   every prototype has exactly one import;
//! - an import has the prototype's parameter count, and each parameter type and the return
//!   type are the C# types the mirror's C-to-C# map gives (`IntPtr` and `nint`, `UIntPtr`
//!   and `nuint`, and the `System` names of the integer types count as the same type);
//! - every sequential struct matches the header struct of its name field by field, and
//!   every header struct has one;
//! - every C# enum matches the header enum of its name member by member, values and
//!   underlying type included, and every header enum has one;
//! - only the imports that may skip the GC transition carry `[SuppressGCTransition]`.
//!
//! The reader fails closed: an import is read in any class, struct, record or interface
//! whatever its modifiers, directive lines such as `#region`, `#pragma` and `#nullable` are
//! read as blank lines, and conditional compilation (`#if`, `#elif`, `#else`) and a native
//! method without `[LibraryImport]` or `[DllImport]` are errors, so no declaration escapes
//! the comparison.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

use crate::ffi_mirror::{self, squash, CType, Header, Position};

/// The directory of the hand-written and generated .NET declarations, relative to the
/// repository root.
pub(crate) const INTEROP: &str = "bindings/dotnet/src/ZeroServer.Native/Interop";

/// One C# attribute: its name without `Attribute` or a namespace, and its argument text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Attribute {
    /// The name, such as `LibraryImport`.
    pub(crate) name: String,
    /// The text inside its parentheses, empty when it has none.
    pub(crate) args: String,
}

/// One parameter, or one field of a struct.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Slot {
    /// The name, without a keyword escape.
    pub(crate) name: String,
    /// The type as written.
    pub(crate) ty: String,
    /// The length of a `fixed` buffer.
    pub(crate) fixed: Option<usize>,
}

/// A method that imports a native function.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Import {
    /// The file that declares it, relative to the Interop directory.
    pub(crate) file: String,
    /// The C symbol: the `EntryPoint` argument, or the method name.
    pub(crate) symbol: String,
    /// The return type as written.
    pub(crate) returns: String,
    /// The parameters.
    pub(crate) params: Vec<Slot>,
    /// The attributes on the method.
    pub(crate) attributes: Vec<Attribute>,
}

/// A struct with `[StructLayout(LayoutKind.Sequential)]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct LayoutStruct {
    /// The file that declares it.
    pub(crate) file: String,
    /// The type name.
    pub(crate) name: String,
    /// The instance fields, in declaration order.
    pub(crate) fields: Vec<Slot>,
}

/// A C# enum.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CsEnum {
    /// The file that declares it.
    pub(crate) file: String,
    /// The type name.
    pub(crate) name: String,
    /// The underlying type, `int` when none is written.
    pub(crate) underlying: String,
    /// Each member and its value.
    pub(crate) members: Vec<(String, i128)>,
}

/// What the C# files of the Interop directory declare.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Declarations {
    /// The native imports.
    pub(crate) imports: Vec<Import>,
    /// The sequential structs.
    pub(crate) structs: Vec<LayoutStruct>,
    /// The enums.
    pub(crate) enums: Vec<CsEnum>,
}

/// Run `cargo xtask surface --check`.
///
/// # Arguments
///
/// * `args` - `--check`, the only mode.
///
/// # Returns
///
/// Success when the declarations match the header, after printing what was compared;
/// otherwise failure, after printing every difference.
pub(crate) fn run(args: &[String]) -> ExitCode {
    if !matches!(args, [arg] if arg == "--check") {
        eprintln!("usage: cargo xtask surface --check");
        return ExitCode::FAILURE;
    }
    let root = crate::docs::repo_root();
    let compared = fs::read_to_string(root.join(ffi_mirror::HEADER))
        .map_err(|err| format!("reading {}: {err}", ffi_mirror::HEADER))
        .and_then(|text| ffi_mirror::parse_header(&text))
        .and_then(|header| {
            let declarations = read_directory(&root.join(INTEROP))?;
            Ok((check(&header, &declarations), header, declarations))
        });
    match compared {
        Ok((problems, header, declarations)) if problems.is_empty() => {
            println!(
                "surface: {INTEROP} matches {}: {} imports, {} structs, {} enums",
                ffi_mirror::HEADER,
                header.functions.len(),
                declarations.structs.len(),
                declarations.enums.len()
            );
            ExitCode::SUCCESS
        }
        Ok((problems, _, _)) => {
            eprint!("{}", report(&problems));
            ExitCode::FAILURE
        }
        Err(message) => {
            eprintln!("xtask surface: {message}");
            ExitCode::FAILURE
        }
    }
}

/// The failure report of `surface --check`: every difference, then what to run.
///
/// # Arguments
///
/// * `problems` - the differences [`check`] found.
///
/// # Returns
///
/// The report, one line per difference and a closing line naming the remedy.
pub(crate) fn report(problems: &[String]) -> String {
    let mut out = format!(
        "xtask surface: {INTEROP} does not match {}:\n",
        ffi_mirror::HEADER
    );
    for problem in problems {
        out.push_str(&format!("  {problem}\n"));
    }
    out.push_str(
        "  run `cargo build -p zero-ffi` and `cargo xtask ffi-mirror --write`, edit the \
         hand-written files named above, and commit the result\n",
    );
    out
}

/// Read every `.cs` file of a directory, in name order.
///
/// # Arguments
///
/// * `dir` - the directory.
///
/// # Returns
///
/// What the files declare together.
///
/// # Errors
///
/// The directory or a file cannot be read, or a declaration cannot be read.
pub(crate) fn read_directory(dir: &Path) -> Result<Declarations, String> {
    let mut paths: Vec<_> = fs::read_dir(dir)
        .map_err(|err| format!("reading {}: {err}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "cs"))
        .collect();
    paths.sort();
    let mut out = Declarations::default();
    for path in paths {
        let text = fs::read_to_string(&path)
            .map_err(|err| format!("reading {}: {err}", path.display()))?;
        let file = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned();
        let found = read_file(&file, &text)?;
        out.imports.extend(found.imports);
        out.structs.extend(found.structs);
        out.enums.extend(found.enums);
    }
    Ok(out)
}

/// Replace comments, preprocessor directive lines, and with `strings` the contents of
/// string and character literals, by spaces, keeping every line break, so an index into
/// the result is an index into `text` and no brace or semicolon inside them reads as
/// structure. A directive line is one whose first character other than white space is `#`
/// outside a comment and a literal; regular, verbatim and raw string literals are known.
///
/// # Errors
///
/// An `#if`, `#elif` or `#else` directive, named with its line: the declarations are read
/// as one set, and keeping every branch would compare declarations that no build compiles
/// together.
fn blank(file: &str, text: &[char], strings: bool) -> Result<Vec<char>, String> {
    let mut out = text.to_vec();
    let at = |i: usize| text.get(i).copied();
    let line_end = |from: usize| {
        (from..text.len())
            .find(|&k| text[k] == '\n')
            .unwrap_or(text.len())
    };
    let clear = |out: &mut Vec<char>, from: usize, to: usize| {
        for c in out.iter_mut().take(to).skip(from) {
            if *c != '\n' && *c != '\r' {
                *c = ' ';
            }
        }
    };
    let mut i = 0;
    let mut line_start = true;
    while let Some(c) = at(i) {
        if c == '\n' {
            line_start = true;
            i += 1;
            continue;
        }
        if c.is_whitespace() {
            i += 1;
            continue;
        }
        if c == '#' && line_start {
            let end = line_end(i);
            let name: String = text[i + 1..end]
                .iter()
                .skip_while(|c| c.is_whitespace())
                .take_while(|c| c.is_ascii_alphabetic())
                .collect();
            if matches!(name.as_str(), "if" | "elif" | "else") {
                let line = text[..i].iter().filter(|c| **c == '\n').count() + 1;
                return Err(format!(
                    "{file}:{line}: `#{name}` makes the declarations depend on the build \
                     configuration; the Interop files are read as one set of declarations, \
                     so they take no conditional compilation"
                ));
            }
            clear(&mut out, i, end);
            i = end;
            continue;
        }
        line_start = false;
        match (c, at(i + 1)) {
            ('/', Some('/')) => {
                let end = line_end(i);
                clear(&mut out, i, end);
                i = end;
            }
            ('/', Some('*')) => {
                let end = (i + 2..text.len())
                    .find(|&k| text[k] == '*' && at(k + 1) == Some('/'))
                    .map_or(text.len(), |k| k + 2);
                clear(&mut out, i, end);
                i = end;
            }
            ('"', _) => {
                let quotes = (i..text.len()).take_while(|&k| text[k] == '"').count();
                let before = |back: usize| i.checked_sub(back).and_then(at);
                let verbatim =
                    before(1) == Some('@') || (before(1) == Some('$') && before(2) == Some('@'));
                let (from, to, next) = if quotes >= 3 {
                    let close = (i + quotes..text.len())
                        .find(|&k| (k..k + quotes).all(|q| at(q) == Some('"')))
                        .unwrap_or(text.len());
                    (i + quotes, close, close + quotes)
                } else if verbatim {
                    let mut k = i + 1;
                    while k < text.len() {
                        if text[k] == '"' {
                            if at(k + 1) == Some('"') {
                                k += 2;
                                continue;
                            }
                            break;
                        }
                        k += 1;
                    }
                    (i + 1, k, k + 1)
                } else {
                    let k = literal_end(text, i + 1, '"');
                    (i + 1, k, k + usize::from(at(k) == Some('"')))
                };
                if strings {
                    clear(&mut out, from, to.min(text.len()));
                }
                i = next;
            }
            ('\'', _) => {
                let k = literal_end(text, i + 1, '\'');
                if strings {
                    clear(&mut out, i + 1, k.min(text.len()));
                }
                i = k + usize::from(at(k) == Some('\''));
            }
            _ => i += 1,
        }
    }
    Ok(out)
}

/// The index of the quote that closes a regular string or character literal whose
/// contents start at `from`, a backslash escaping the character after it; the end of the
/// line or of the text when the literal is never closed.
fn literal_end(text: &[char], from: usize, quote: char) -> usize {
    let mut k = from;
    while k < text.len() && text[k] != quote && text[k] != '\n' {
        if text[k] == '\\' {
            k += 1;
        }
        k += 1;
    }
    k
}

/// What a `{` opened.
enum Container {
    /// A class, struct, record or interface, whose methods are read for imports; for a
    /// sequential struct, its index, and its fields are read too.
    Type(Option<usize>),
    /// An enum, by index.
    Enum(usize),
    /// Any other body: a namespace, a method, an accessor or an initializer.
    Other,
}

/// Read one C# file.
///
/// # Arguments
///
/// * `file` - its name, for the messages.
/// * `text` - its contents.
///
/// # Returns
///
/// The imports, sequential structs and enums it declares.
///
/// # Errors
///
/// Conditional compilation, a native method without an import attribute, or an import,
/// field or enum member that cannot be read, named in the message.
pub(crate) fn read_file(file: &str, text: &str) -> Result<Declarations, String> {
    let source: Vec<char> = text.chars().collect();
    let content = blank(file, &source, false)?;
    let structure = blank(file, &source, true)?;
    let mut out = Declarations::default();
    let mut stack: Vec<Container> = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (i, &c) in structure.iter().enumerate() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            '{' | '}' | ';' if depth == 0 => {
                let segment: String = content[start..i].iter().collect();
                let shape: String = structure[start..i].iter().collect();
                start = i + 1;
                match c {
                    '{' => stack.push(open(file, &segment, &shape, &mut out)?),
                    '}' => {
                        if let Some(Container::Enum(index)) = stack.pop() {
                            if let Some(item) = out.enums.get_mut(index) {
                                item.members = enum_members(file, &item.name, &segment)?;
                            }
                        }
                    }
                    _ => {
                        if let Some(Container::Type(layout)) = stack.last() {
                            if let Some(import) = import(file, &segment, &shape)? {
                                out.imports.push(import);
                            } else if let Some(index) = layout {
                                if let Some(field) = field(file, &segment, &shape)? {
                                    if let Some(item) = out.structs.get_mut(*index) {
                                        item.fields.push(field);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    Ok(out)
}

/// Split the leading attribute lists off a declaration.
///
/// # Returns
///
/// The attributes and the declaration after them, trimmed.
fn split_attributes(segment: &str, shape: &str) -> (Vec<Attribute>, String) {
    let mut out = Vec::new();
    let chars: Vec<char> = shape.chars().collect();
    let text: Vec<char> = segment.chars().collect();
    let mut i = 0;
    loop {
        while chars.get(i).is_some_and(|c| c.is_whitespace()) {
            i += 1;
        }
        if chars.get(i) != Some(&'[') {
            break;
        }
        let mut depth = 0usize;
        let mut end = None;
        for (k, c) in chars.iter().enumerate().skip(i) {
            match c {
                '[' | '(' => depth += 1,
                ']' | ')' => {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        end = Some(k);
                        break;
                    }
                }
                _ => {}
            }
        }
        let Some(end) = end else {
            break;
        };
        let inner: String = text[i + 1..end].iter().collect();
        let inner_shape: String = chars[i + 1..end].iter().collect();
        for (from, to) in top_level_commas(&inner_shape) {
            let one: String = inner.chars().skip(from).take(to - from).collect();
            let one = one.trim();
            let one = one
                .split_once(':')
                .filter(|(target, _)| !target.contains('('))
                .map_or(one, |(_, rest)| rest.trim());
            let (name, args) = match one.split_once('(') {
                Some((name, args)) => (name.trim(), args.trim_end().trim_end_matches(')')),
                None => (one, ""),
            };
            let name = name.rsplit('.').next().unwrap_or(name);
            let name = name.strip_suffix("Attribute").unwrap_or(name);
            out.push(Attribute {
                name: name.to_owned(),
                args: args.trim().to_owned(),
            });
        }
        i = end + 1;
    }
    let rest: String = text.iter().skip(i).collect();
    (out, rest.trim().to_owned())
}

/// The `[from, to)` character ranges of `shape` between its commas outside every bracket.
fn top_level_commas(shape: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    let chars: Vec<char> = shape.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        match c {
            '(' | '[' | '<' | '{' => depth += 1,
            ')' | ']' | '>' | '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                out.push((start, i));
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push((start, chars.len()));
    out
}

/// The modifiers a member declaration may start with, which are not part of its type.
const MODIFIERS: [&str; 17] = [
    "public",
    "private",
    "internal",
    "protected",
    "static",
    "partial",
    "extern",
    "unsafe",
    "new",
    "readonly",
    "volatile",
    "file",
    "required",
    "abstract",
    "sealed",
    "virtual",
    "override",
];

/// Classify the declaration a `{` opens, recording a sequential struct or an enum. A type
/// keyword before any parameter list opens a type whatever modifiers come before it
/// (`sealed`, `abstract`, `static`, `partial`, `ref` and the rest), so no class hides its
/// imports; a method whose constraint names `class` or `struct` has its parameter list
/// first and opens a body.
fn open(
    file: &str,
    segment: &str,
    shape: &str,
    out: &mut Declarations,
) -> Result<Container, String> {
    let (attributes, rest) = split_attributes(segment, shape);
    let head = rest.split('(').next().unwrap_or_default();
    let words: Vec<&str> = head.split_whitespace().collect();
    let Some(keyword) = words
        .iter()
        .position(|word| matches!(*word, "class" | "struct" | "enum" | "interface" | "record"))
    else {
        return Ok(Container::Other);
    };
    let name = words
        .get(keyword + 1)
        .and_then(|word| {
            word.split(|c: char| !(c.is_alphanumeric() || c == '_'))
                .next()
        })
        .unwrap_or_default()
        .to_owned();
    Ok(match words[keyword] {
        "struct" => {
            let sequential = attributes.iter().any(|attribute| {
                attribute.name == "StructLayout" && attribute.args.contains("Sequential")
            });
            if sequential {
                out.structs.push(LayoutStruct {
                    file: file.to_owned(),
                    name,
                    fields: Vec::new(),
                });
                Container::Type(Some(out.structs.len() - 1))
            } else {
                Container::Type(None)
            }
        }
        "enum" => {
            let underlying = rest
                .split_once(':')
                .map(|(_, ty)| ty.trim().to_owned())
                .unwrap_or_else(|| "int".to_owned());
            if name.is_empty() {
                return Err(format!("{file}: cannot name the enum in `{rest}`"));
            }
            out.enums.push(CsEnum {
                file: file.to_owned(),
                name,
                underlying,
                members: Vec::new(),
            });
            Container::Enum(out.enums.len() - 1)
        }
        _ => Container::Type(None),
    })
}

/// The last identifier of a declaration and the text before it.
fn split_name(text: &str) -> Option<(&str, &str)> {
    let text = text.trim_end();
    let start = text
        .rfind(|c: char| !(c.is_alphanumeric() || c == '_' || c == '@'))
        .map_or(0, |at| at + 1);
    let name = &text[start..];
    if name.is_empty() {
        None
    } else {
        Some((text[..start].trim_end(), name.trim_start_matches('@')))
    }
}

/// The byte offsets of the `(` and `)` of the parameter list a declaration ends with, or
/// `None` when it does not end with one.
fn parameter_list(declaration: &str) -> Option<(usize, usize)> {
    let close = declaration
        .rfind(')')
        .filter(|close| declaration[close + 1..].trim().is_empty())?;
    let mut depth = 0usize;
    for (at, c) in declaration[..=close].char_indices().rev() {
        match c {
            ')' => depth += 1,
            '(' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some((at, close));
                }
            }
            _ => {}
        }
    }
    None
}

/// Whether a declaration is a method without a body that only the runtime or a source
/// generator can supply: an `extern` method, or a `static partial` one.
fn declares_native_method(declaration: &str) -> bool {
    let Some((open, _)) = parameter_list(declaration) else {
        return false;
    };
    let head = &declaration[..open];
    if head.contains('=') {
        return false;
    }
    let words: Vec<&str> = head.split_whitespace().collect();
    words.contains(&"extern") || (words.contains(&"static") && words.contains(&"partial"))
}

/// Read a member declaration of a type, keeping it when it imports a native function.
///
/// # Errors
///
/// An import that cannot be read, or a native method without `[LibraryImport]` or
/// `[DllImport]`, which no check could hold to the header.
fn import(file: &str, segment: &str, shape: &str) -> Result<Option<Import>, String> {
    let (attributes, rest) = split_attributes(segment, shape);
    let Some(native) = attributes
        .iter()
        .find(|attribute| matches!(attribute.name.as_str(), "LibraryImport" | "DllImport"))
    else {
        if declares_native_method(&rest) {
            return Err(format!(
                "{file}: `{}` declares a native method without [LibraryImport] or [DllImport]",
                squash(&rest)
            ));
        }
        return Ok(None);
    };
    let unreadable = || format!("{file}: cannot read the import `{}`", squash(&rest));
    let (open, close) = parameter_list(&rest).ok_or_else(unreadable)?;
    let (head, method) = split_name(&rest[..open]).ok_or_else(unreadable)?;
    let mut words: Vec<&str> = head.split_whitespace().collect();
    while words.first().is_some_and(|word| MODIFIERS.contains(word)) {
        words.remove(0);
    }
    let returns = words.join(" ");
    if returns.is_empty() {
        return Err(unreadable());
    }
    let symbol = entry_point(&native.args).unwrap_or_else(|| method.to_owned());
    let list = &rest[open + 1..close];
    let mut params = Vec::new();
    if !list.trim().is_empty() {
        for (from, to) in top_level_commas(list) {
            let part: String = list.chars().skip(from).take(to - from).collect();
            let (_, part) = split_attributes(&part, &part);
            let part = part.split_once('=').map_or(part.as_str(), |(head, _)| head);
            let (ty, name) = split_name(part).ok_or_else(unreadable)?;
            if ty.is_empty() {
                return Err(unreadable());
            }
            params.push(Slot {
                name: name.to_owned(),
                ty: ty.to_owned(),
                fixed: None,
            });
        }
    }
    Ok(Some(Import {
        file: file.to_owned(),
        symbol,
        returns,
        params,
        attributes,
    }))
}

/// The `EntryPoint = "..."` argument of an import attribute.
fn entry_point(args: &str) -> Option<String> {
    let at = args.find("EntryPoint")?;
    let rest = args[at + "EntryPoint".len()..]
        .trim_start()
        .strip_prefix('=')?;
    let rest = rest.trim_start().strip_prefix('"')?;
    rest.split_once('"').map(|(name, _)| name.to_owned())
}

/// Read a field declaration of a sequential struct; a static or constant member is none.
fn field(file: &str, segment: &str, shape: &str) -> Result<Option<Slot>, String> {
    let (_, rest) = split_attributes(segment, shape);
    if rest.is_empty() || rest.contains('(') || rest.contains("=>") {
        return Ok(None);
    }
    let mut words: Vec<&str> = rest.split_whitespace().collect();
    if words.iter().any(|word| matches!(*word, "static" | "const")) {
        return Ok(None);
    }
    let mut fixed = false;
    while let Some(first) = words.first() {
        if *first == "fixed" {
            fixed = true;
        } else if !MODIFIERS.contains(first) {
            break;
        }
        words.remove(0);
    }
    let declaration = words.join(" ");
    let unreadable = || format!("{file}: cannot read the field `{}`", squash(&rest));
    let (declaration, len) = match declaration
        .strip_suffix(']')
        .and_then(|d| d.rsplit_once('['))
    {
        Some((head, len)) if fixed => (
            head.to_owned(),
            Some(len.trim().parse::<usize>().map_err(|_| unreadable())?),
        ),
        _ => (declaration.clone(), None),
    };
    let (ty, name) = split_name(&declaration).ok_or_else(unreadable)?;
    if ty.is_empty() {
        return Err(unreadable());
    }
    Ok(Some(Slot {
        name: name.to_owned(),
        ty: ty.to_owned(),
        fixed: len,
    }))
}

/// The members of an enum body, an implicit value one more than the previous one.
fn enum_members(file: &str, name: &str, body: &str) -> Result<Vec<(String, i128)>, String> {
    let mut out = Vec::new();
    let mut next: i128 = 0;
    for (from, to) in top_level_commas(body) {
        let part: String = body.chars().skip(from).take(to - from).collect();
        let (_, part) = split_attributes(&part, &part);
        if part.is_empty() {
            continue;
        }
        let (member, value) = match part.split_once('=') {
            Some((member, value)) => (
                member.trim().to_owned(),
                cs_integer(value.trim()).ok_or_else(|| {
                    format!("{file}: cannot read the value of {name}.{}", member.trim())
                })?,
            ),
            None => (part.trim().to_owned(), next),
        };
        next = value
            .checked_add(1)
            .ok_or_else(|| format!("{file}: the value of {name}.{member} overflows"))?;
        out.push((member, value));
    }
    Ok(out)
}

/// A C# integer literal: decimal or hexadecimal, optionally negative, with digit
/// separators and any `u` and `l` suffixes.
fn cs_integer(text: &str) -> Option<i128> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest.trim()),
        None => (false, text),
    };
    let digits: String = digits
        .trim_end_matches(['u', 'U', 'l', 'L'])
        .chars()
        .filter(|c| *c != '_')
        .collect();
    let value = match digits
        .strip_prefix("0x")
        .or_else(|| digits.strip_prefix("0X"))
    {
        Some(hex) => i128::from_str_radix(hex, 16).ok()?,
        None => digits.parse::<i128>().ok()?,
    };
    Some(if negative { -value } else { value })
}

/// A C# type in a canonical spelling: the `System` names of the built-in types become
/// their keywords (`IntPtr` is `nint`), a `global::` or `System.` qualifier is dropped, and
/// whitespace is kept only between two words.
///
/// # Arguments
///
/// * `ty` - the type as written.
///
/// # Returns
///
/// The canonical spelling, equal for two spellings of one type.
pub(crate) fn canonical(ty: &str) -> String {
    let ty = ty.replace("global::", "").replace("System.", "");
    let mut out = String::new();
    let mut word = String::new();
    let mut last_was_word = false;
    let flush = |word: &mut String, out: &mut String, last_was_word: &mut bool| {
        if word.is_empty() {
            return;
        }
        if *last_was_word {
            out.push(' ');
        }
        out.push_str(match word.as_str() {
            "IntPtr" => "nint",
            "UIntPtr" => "nuint",
            "Byte" => "byte",
            "SByte" => "sbyte",
            "Int16" => "short",
            "UInt16" => "ushort",
            "Int32" => "int",
            "UInt32" => "uint",
            "Int64" => "long",
            "UInt64" => "ulong",
            "Single" => "float",
            "Double" => "double",
            "Void" => "void",
            other => other,
        });
        word.clear();
        *last_was_word = true;
    };
    for c in ty.chars() {
        if c.is_alphanumeric() || c == '_' {
            word.push(c);
            continue;
        }
        flush(&mut word, &mut out, &mut last_was_word);
        if !c.is_whitespace() {
            out.push(c);
            last_was_word = false;
        }
    }
    flush(&mut word, &mut out, &mut last_was_word);
    out
}

/// The C# type of a C enum's underlying type: the typedef that names it, or `int`, the
/// type of a C enum without one.
fn underlying(header: &Header, name: &str) -> Option<&'static str> {
    let item = header.enums.iter().find(|item| item.name == name)?;
    match &item.underlying {
        Some(ty) => ffi_mirror::primitive(ty),
        None => Some("int"),
    }
}

/// Compare the declarations with the header.
///
/// # Arguments
///
/// * `header` - the parsed header.
/// * `declarations` - the parsed C# files.
///
/// # Returns
///
/// Every difference, one sentence each; empty when they match.
pub(crate) fn check(header: &Header, declarations: &Declarations) -> Vec<String> {
    let mut problems = Vec::new();
    let mut imported: BTreeMap<&str, Vec<&Import>> = BTreeMap::new();
    for import in &declarations.imports {
        imported.entry(&import.symbol).or_default().push(import);
    }
    for function in &header.functions {
        match imported.get(function.name.as_str()).map(Vec::as_slice) {
            None | Some([]) => problems.push(format!(
                "{} is exported by the header and imported by no declaration",
                function.name
            )),
            Some([import]) => compare_import(header, function, import, &mut problems),
            Some(many) => problems.push(format!(
                "{} is imported {} times ({})",
                function.name,
                many.len(),
                many.iter()
                    .map(|import| import.file.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
    for import in &declarations.imports {
        if !header
            .functions
            .iter()
            .any(|function| function.name == import.symbol)
        {
            problems.push(format!(
                "{}: {} imports a function the header does not declare",
                import.file, import.symbol
            ));
        }
        let suppressed = import
            .attributes
            .iter()
            .any(|attribute| attribute.name == "SuppressGCTransition");
        if suppressed && !ffi_mirror::SUPPRESS_GC_TRANSITION.contains(&import.symbol.as_str()) {
            problems.push(format!(
                "{}: {} skips the GC transition, which only {} may",
                import.file,
                import.symbol,
                ffi_mirror::SUPPRESS_GC_TRANSITION.join(", ")
            ));
        }
    }
    compare_structs(header, declarations, &mut problems);
    compare_enums(header, declarations, &mut problems);
    problems
}

/// Compare one import with its prototype.
fn compare_import(
    header: &Header,
    function: &ffi_mirror::Function,
    import: &Import,
    problems: &mut Vec<String>,
) {
    let at = format!("{}: {}", import.file, function.name);
    let expected = function.signature.params.len();
    if import.params.len() != expected {
        problems.push(format!(
            "{at} takes {} parameters; the header gives it {expected}",
            import.params.len()
        ));
        return;
    }
    match header.cs_type(&function.signature.returns, Position::Return) {
        Ok(ty) if canonical(&ty) == canonical(&import.returns) => {}
        Ok(ty) => problems.push(format!(
            "{at} returns {}; the type map gives {ty}",
            import.returns
        )),
        Err(err) => problems.push(format!("{at}: {err}")),
    }
    for (param, slot) in function.signature.params.iter().zip(&import.params) {
        match header.cs_type(&param.ty, Position::Param) {
            Ok(ty) if canonical(&ty) == canonical(&slot.ty) => {}
            Ok(ty) => problems.push(format!(
                "{at} parameter {} is {}; the type map gives {ty}",
                param.name, slot.ty
            )),
            Err(err) => problems.push(format!("{at} parameter {}: {err}", param.name)),
        }
    }
}

/// Compare the sequential structs with the header structs.
fn compare_structs(header: &Header, declarations: &Declarations, problems: &mut Vec<String>) {
    for item in &header.structs {
        let mirrors: Vec<&LayoutStruct> = declarations
            .structs
            .iter()
            .filter(|mirror| mirror.name == item.name)
            .collect();
        let [mirror] = mirrors.as_slice() else {
            problems.push(format!(
                "struct {} of the header has {} sequential structs of its name; it needs one",
                item.name,
                mirrors.len()
            ));
            continue;
        };
        let at = format!("{}: {}", mirror.file, item.name);
        if mirror.fields.len() != item.fields.len() {
            problems.push(format!(
                "{at} has {} fields; the header gives it {}",
                mirror.fields.len(),
                item.fields.len()
            ));
            continue;
        }
        for (field, slot) in item.fields.iter().zip(&mirror.fields) {
            if field.name != slot.name {
                problems.push(format!(
                    "{at} field {} is named {} in C#",
                    field.name, slot.name
                ));
            }
            let len = match &field.ty {
                CType::Array { len, .. } => Some(*len),
                _ => None,
            };
            if len != slot.fixed {
                let shape = |len: Option<usize>| {
                    len.map_or_else(
                        || "not a fixed buffer".to_owned(),
                        |len| format!("a fixed buffer of {len} elements"),
                    )
                };
                problems.push(format!(
                    "{at} field {} is {} in C#; the header gives {}",
                    field.name,
                    shape(slot.fixed),
                    shape(len)
                ));
            }
            match header.cs_type(&field.ty, Position::Field) {
                Ok(ty) if canonical(&ty) == canonical(&slot.ty) => {}
                Ok(ty) => problems.push(format!(
                    "{at} field {} is {}; the type map gives {ty}",
                    field.name, slot.ty
                )),
                Err(err) => problems.push(format!("{at} field {}: {err}", field.name)),
            }
        }
    }
    for mirror in &declarations.structs {
        if !header.structs.iter().any(|item| item.name == mirror.name) {
            problems.push(format!(
                "{}: the sequential struct {} mirrors no struct of the header",
                mirror.file, mirror.name
            ));
        }
    }
}

/// Compare the C# enums with the header enums, whose variants carry the enum name as a
/// prefix (`ZeroStatus_Ok` is `ZeroStatus.Ok`).
fn compare_enums(header: &Header, declarations: &Declarations, problems: &mut Vec<String>) {
    for item in &header.enums {
        let mirrors: Vec<&CsEnum> = declarations
            .enums
            .iter()
            .filter(|mirror| mirror.name == item.name)
            .collect();
        let [mirror] = mirrors.as_slice() else {
            problems.push(format!(
                "enum {} of the header has {} C# enums of its name; it needs one",
                item.name,
                mirrors.len()
            ));
            continue;
        };
        let at = format!("{}: {}", mirror.file, item.name);
        match underlying(header, &item.name) {
            Some(ty) if canonical(ty) == canonical(&mirror.underlying) => {}
            Some(ty) => problems.push(format!(
                "{at} is backed by {}; the header gives {ty}",
                mirror.underlying
            )),
            None => problems.push(format!("{at}: its underlying type has no C# spelling")),
        }
        let prefix = format!("{}_", item.name);
        let expected: BTreeMap<&str, i128> = item
            .variants
            .iter()
            .map(|(variant, value)| {
                let variant = variant.as_str();
                (
                    variant.strip_prefix(prefix.as_str()).unwrap_or(variant),
                    *value,
                )
            })
            .collect();
        let actual: BTreeMap<&str, i128> = mirror
            .members
            .iter()
            .map(|(member, value)| (member.as_str(), *value))
            .collect();
        for (member, value) in &expected {
            match actual.get(member) {
                None => problems.push(format!("{at} has no member {member} (= {value})")),
                Some(found) if found != value => problems.push(format!(
                    "{at}.{member} is {found}; the header gives {value}"
                )),
                Some(_) => {}
            }
        }
        for (member, value) in &actual {
            if !expected.contains_key(member) {
                problems.push(format!(
                    "{at}.{member} (= {value}) is not a variant of the header"
                ));
            }
        }
    }
    for mirror in &declarations.enums {
        if !header.enums.iter().any(|item| item.name == mirror.name) {
            problems.push(format!(
                "{}: the enum {} mirrors no enum of the header",
                mirror.file, mirror.name
            ));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ffi_mirror::tests::SAMPLE_HEADER;

    /// The hand-written enum that goes beside the generated declarations of the sample
    /// header.
    const SAMPLE_ENUM: &str = r#"namespace ZeroServer.Native.Interop;

/// <summary>The result of a call; see <c>zero.h</c> { and ; in prose }.</summary>
public enum ZeroStatus
{
    /// <summary>The call succeeded.</summary>
    Ok = 0,
    Protocol = 1,
    Io,
    InvalidArgument = 0x9,
}
"#;

    /// A hand-written declaration file in the shape `NativeMethods.cs` has.
    const SAMPLE_HAND_WRITTEN: &str = r#"using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

[assembly: DisableRuntimeMarshalling]

namespace ZeroServer.Native.Interop;

/// <summary>The imports; a ";" or "{" in a string never ends a declaration.</summary>
public static partial class NativeMethods
{
    private const string Library = "zero_ffi;{";

    [ModuleInitializer]
    internal static void Register()
    {
        NativeLibrary.SetDllImportResolver(typeof(NativeMethods).Assembly, (name, assembly, path) => IntPtr.Zero);
    }
}
"#;

    fn sample_declarations(generated: &str) -> Declarations {
        let mut out = read_file("NativeMethods.g.cs", generated).unwrap();
        let hand = read_file("NativeMethods.cs", SAMPLE_HAND_WRITTEN).unwrap();
        let status = read_file("ZeroStatus.cs", SAMPLE_ENUM).unwrap();
        out.imports.extend(hand.imports);
        out.enums.extend(status.enums);
        out
    }

    #[test]
    fn the_mirror_of_a_header_and_its_hand_written_enum_match_the_header() {
        let header = ffi_mirror::parse_header(SAMPLE_HEADER).unwrap();
        let generated = ffi_mirror::render(&header).unwrap();
        let declarations = sample_declarations(&generated);
        assert_eq!(declarations.imports.len(), header.functions.len());
        assert_eq!(declarations.structs.len(), header.structs.len());
        assert_eq!(declarations.enums.len(), 1);
        assert_eq!(check(&header, &declarations), Vec::<String>::new());
    }

    #[test]
    fn the_reader_takes_attributes_entry_points_fixed_buffers_and_implicit_values() {
        let text = r#"
namespace N;

[StructLayout(LayoutKind.Sequential)]
public unsafe struct ZeroPeer
{
    public uint size;
    public fixed byte reserved[7];
    public static readonly int Ignored = 1;
    public const int AlsoIgnored = 2;
    public delegate* unmanaged<void*, uint, ulong, int> handle;
}

public struct NotMirrored
{
    public int value;
}

public static unsafe partial class NativeMethods
{
    [LibraryImport("zero_ffi", EntryPoint = "zero_req_view"), SuppressGCTransition]
    [return: MarshalAs(UnmanagedType.I4)]
    public static partial ZeroStatus RequestView(ulong slot, ZeroPeer* view_out);

    [DllImport("zero_ffi")]
    internal static extern System.IntPtr zero_version();

    public static int NotAnImport(int a) => a;
}

public enum Mode : uint
{
    A = -1,
    B,
    [Obsolete] C = 1_0,
}
"#;
        let found = read_file("x.cs", text).unwrap();
        assert_eq!(found.structs.len(), 1);
        let peer = &found.structs[0];
        assert_eq!(peer.name, "ZeroPeer");
        let names: Vec<&str> = peer.fields.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["size", "reserved", "handle"]);
        assert_eq!(peer.fields[1].fixed, Some(7));
        assert_eq!(peer.fields[1].ty, "byte");
        assert_eq!(
            peer.fields[2].ty,
            "delegate* unmanaged<void*, uint, ulong, int>"
        );
        assert_eq!(found.imports.len(), 2);
        let view = &found.imports[0];
        assert_eq!(view.symbol, "zero_req_view");
        assert_eq!(view.returns, "ZeroStatus");
        assert_eq!(view.params.len(), 2);
        assert_eq!(view.params[1].ty, "ZeroPeer*");
        assert_eq!(view.params[1].name, "view_out");
        let attributes: Vec<&str> = view.attributes.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(
            attributes,
            ["LibraryImport", "SuppressGCTransition", "MarshalAs"]
        );
        assert_eq!(found.imports[1].symbol, "zero_version");
        assert_eq!(canonical(&found.imports[1].returns), "nint");
        assert_eq!(found.imports[1].params.len(), 0);
        assert_eq!(
            found.enums,
            [CsEnum {
                file: "x.cs".to_owned(),
                name: "Mode".to_owned(),
                underlying: "uint".to_owned(),
                members: vec![
                    ("A".to_owned(), -1),
                    ("B".to_owned(), 0),
                    ("C".to_owned(), 10)
                ],
            }]
        );
    }

    #[test]
    fn two_spellings_of_one_type_are_one_canonical_type() {
        assert_eq!(canonical("IntPtr"), canonical("nint"));
        assert_eq!(canonical("System.UIntPtr"), "nuint");
        assert_eq!(canonical("global::System.Int32"), "int");
        assert_eq!(canonical("byte *"), "byte*");
        assert_eq!(
            canonical("delegate* unmanaged< void*,uint >"),
            canonical("delegate* unmanaged<void*, uint>")
        );
        assert_ne!(canonical("byte*"), canonical("nint"));
        assert_ne!(canonical("uint"), canonical("int"));
    }

    #[test]
    fn every_difference_from_the_header_is_reported() {
        let header = ffi_mirror::parse_header(SAMPLE_HEADER).unwrap();
        let generated = ffi_mirror::render(&header)
            .unwrap()
            .replace(
                "ZeroStatus zero_app_route(ulong app,",
                "ZeroStatus zero_app_route(long app,",
            )
            .replace(
                "zero_conformance_case(byte* section, nuint section_len, nint* result_out)",
                "zero_conformance_case(byte* section, nuint section_len)",
            )
            .replace("partial uint zero_abi_version()", "partial int zero_abi_version()")
            .replace(
                "[LibraryImport(Library)]\n    public static partial void zero_string_free",
                "[LibraryImport(Library)]\n    [SuppressGCTransition]\n    public static partial void zero_string_free",
            )
            .replace("    public nuint len;\n", "    public uint len;\n")
            .replace("    public byte* ptr;\n", "    public byte* data;\n")
            .replace(
                "    public fixed byte reserved[7];\n",
                "    public fixed byte reserved[8];\n",
            )
            .replace(
                "    [LibraryImport(Library)]\n    public static partial nint zero_buffer_data(nint buffer);\n",
                "",
            );
        let mut declarations = sample_declarations(&generated);
        let extra = read_file(
            "Extra.cs",
            concat!(
                "public static partial class NativeMethods\n{\n",
                "    [LibraryImport(Library)]\n    public static partial void zero_last_error_message();\n",
                "    [LibraryImport(Library)]\n    public static partial nint zero_version();\n}\n",
                "[StructLayout(LayoutKind.Sequential)]\npublic struct ZeroExtra\n{\n    public int a;\n}\n",
            ),
        )
        .unwrap();
        declarations.imports.extend(extra.imports);
        declarations.structs.extend(extra.structs);
        declarations.enums[0]
            .members
            .retain(|(name, _)| name != "Io");
        declarations.enums[0].members.push(("Extra".to_owned(), 11));
        if let Some(member) = declarations.enums[0]
            .members
            .iter_mut()
            .find(|(name, _)| name == "Protocol")
        {
            member.1 = 5;
        }
        declarations.enums[0].underlying = "byte".to_owned();
        let problems = check(&header, &declarations);
        for expected in [
            "NativeMethods.g.cs: zero_app_route parameter app is long; the type map gives ulong",
            "NativeMethods.g.cs: zero_conformance_case takes 2 parameters; the header gives it 3",
            "NativeMethods.g.cs: zero_abi_version returns int; the type map gives uint",
            "NativeMethods.g.cs: zero_string_free skips the GC transition, which only zero_abi_version, zero_req_view, zero_req_method, zero_slot_route may",
            "NativeMethods.g.cs: ZeroBytes field len is uint; the type map gives nuint",
            "zero_buffer_data is exported by the header and imported by no declaration",
            "Extra.cs: zero_last_error_message imports a function the header does not declare",
            "zero_version is imported 2 times (NativeMethods.g.cs, Extra.cs)",
            "ZeroStatus.cs: ZeroStatus has no member Io (= 2)",
            "ZeroStatus.cs: ZeroStatus.Protocol is 5; the header gives 1",
            "ZeroStatus.cs: ZeroStatus.Extra (= 11) is not a variant of the header",
            "ZeroStatus.cs: ZeroStatus is backed by byte; the header gives int",
            "NativeMethods.g.cs: ZeroBytes field ptr is named data in C#",
            "NativeMethods.g.cs: ZeroPeer field reserved is a fixed buffer of 8 elements in C#; the header gives a fixed buffer of 7 elements",
            "Extra.cs: the sequential struct ZeroExtra mirrors no struct of the header",
        ] {
            assert!(
                problems.iter().any(|problem| problem == expected),
                "missing {expected:?} in {problems:#?}"
            );
        }
        assert_eq!(problems.len(), 15, "{problems:#?}");
    }

    #[test]
    fn a_struct_with_a_field_fewer_than_the_header_is_reported_once() {
        let header = ffi_mirror::parse_header(SAMPLE_HEADER).unwrap();
        let generated = ffi_mirror::render(&header)
            .unwrap()
            .replace("    public void* ctx;\n", "");
        let problems = check(&header, &sample_declarations(&generated));
        assert_eq!(
            problems,
            ["NativeMethods.g.cs: ZeroPeer has 6 fields; the header gives it 7"]
        );
    }

    /// One import that skips the GC transition although it may not, behind each directive
    /// line a hand-written file may carry.
    const BEHIND_DIRECTIVES: [&str; 3] = [
        "#nullable enable\nusing System.Runtime.InteropServices;\n\nnamespace N;\n\n#nullable disable\npublic static partial class Hand\n{\n    [LibraryImport(\"zero_ffi\", EntryPoint = \"zero_app_route\")]\n    [SuppressGCTransition]\n    public static partial ZeroStatus RouteFast(ulong app);\n}\n",
        "public static partial class Hand\n{\n    #region Imports\n    [LibraryImport(\"zero_ffi\", EntryPoint = \"zero_app_route\")]\n    [SuppressGCTransition]\n    public static partial ZeroStatus RouteFast(ulong app);\n    #endregion\n}\n",
        "public static partial class Hand\n{\n#pragma warning disable CA1401\n    [LibraryImport(\"zero_ffi\", EntryPoint = \"zero_app_route\")]\n    [SuppressGCTransition]\n    public static partial ZeroStatus RouteFast(ulong app);\n#pragma warning restore CA1401\n}\n",
    ];

    #[test]
    fn a_directive_line_hides_no_import_and_no_attribute() {
        let header = ffi_mirror::parse_header(SAMPLE_HEADER).unwrap();
        for text in BEHIND_DIRECTIVES {
            let hand = read_file("Hand.cs", text).unwrap();
            let read: Vec<(&str, Vec<&str>)> = hand
                .imports
                .iter()
                .map(|import| {
                    (
                        import.symbol.as_str(),
                        import.attributes.iter().map(|a| a.name.as_str()).collect(),
                    )
                })
                .collect();
            assert_eq!(
                read,
                [(
                    "zero_app_route",
                    vec!["LibraryImport", "SuppressGCTransition"]
                )],
                "{text}"
            );
            let mut declarations = sample_declarations(&ffi_mirror::render(&header).unwrap());
            declarations.imports.extend(hand.imports);
            let problems = check(&header, &declarations);
            assert!(
                problems.contains(
                    &"Hand.cs: zero_app_route skips the GC transition, which only zero_abi_version, zero_req_view, zero_req_method, zero_slot_route may"
                        .to_owned()
                ),
                "{problems:#?}"
            );
            assert!(problems.contains(
                &"zero_app_route is imported 2 times (NativeMethods.g.cs, Hand.cs)".to_owned()
            ));
        }
    }

    #[test]
    fn an_import_is_read_in_a_type_whatever_its_modifiers() {
        let text = concat!(
            "public sealed partial class A\n{\n    [DllImport(\"zero_ffi\")]\n    public static extern nint zero_version();\n}\n",
            "public abstract partial class B\n{\n    [LibraryImport(\"zero_ffi\")]\n    internal static partial uint zero_abi_version();\n}\n",
            "internal partial struct C\n{\n    [LibraryImport(\"zero_ffi\")]\n    private static partial void zero_string_free(nint @string);\n}\n",
            "public static unsafe partial class D\n{\n    public sealed class Nested\n    {\n        [DllImport(\"zero_ffi\", EntryPoint = \"zero_req_view\")]\n        public static extern ZeroStatus View(ulong slot, ZeroPeer* view_out);\n    }\n}\n",
        );
        let found = read_file("Hand.cs", text).unwrap();
        let symbols: Vec<&str> = found.imports.iter().map(|i| i.symbol.as_str()).collect();
        assert_eq!(
            symbols,
            [
                "zero_version",
                "zero_abi_version",
                "zero_string_free",
                "zero_req_view"
            ]
        );
    }

    #[test]
    fn conditional_compilation_in_an_interop_file_is_refused() {
        for (text, at) in [
            (
                "namespace N;\n\n#if NET10_0_OR_GREATER\npublic static partial class A { }\n#endif\n",
                "Hand.cs:3: `#if` ",
            ),
            ("class A\n{\n#elif X\n}\n", "Hand.cs:3: `#elif` "),
            ("class A\n{\n  #  else\n}\n", "Hand.cs:3: `#else` "),
        ] {
            let err = read_file("Hand.cs", text).unwrap_err();
            assert!(err.starts_with(at), "{err}");
        }
        let not_directives = concat!(
            "class A\n{\n",
            "    // #if in a line comment\n",
            "    /* a block comment\n#if inside it */\n",
            "    const string S = \"#if in a string\";\n",
            "    const string V = @\"a verbatim string\n#if inside it\";\n",
            "    const string R = \"\"\"\n#if in a raw string\n\"\"\";\n",
            "    const char C = '#';\n",
            "}\n",
        );
        assert!(read_file("Hand.cs", not_directives).is_ok());
    }

    #[test]
    fn a_native_method_without_an_import_attribute_is_refused() {
        for text in [
            "static class A\n{\n    public static extern int zero_x();\n}\n",
            "static partial class A\n{\n    internal static partial int zero_y(int a);\n}\n",
            "partial struct A\n{\n    static extern void zero_z();\n}\n",
        ] {
            let err = read_file("Hand.cs", text).unwrap_err();
            assert!(
                err.contains("declares a native method without [LibraryImport] or [DllImport]"),
                "{err}"
            );
        }
        let not_native = concat!(
            "static partial class A\n{\n",
            "    public static partial int Helper() => 1;\n",
            "    partial void OnLoaded();\n",
            "    public delegate void Callback(int a);\n",
            "    static readonly System.Func<int> F = Make();\n",
            "    static int Make() => 1;\n",
            "}\n",
        );
        assert!(read_file("Hand.cs", not_native).unwrap().imports.is_empty());
    }

    #[test]
    fn the_failure_report_ends_with_what_to_run() {
        assert_eq!(
            report(&["a difference".to_owned()]),
            format!(
                "xtask surface: {INTEROP} does not match {}:\n  a difference\n  run `cargo build -p zero-ffi` and `cargo xtask ffi-mirror --write`, edit the hand-written files named above, and commit the result\n",
                ffi_mirror::HEADER
            )
        );
    }

    #[test]
    fn a_header_struct_or_enum_without_a_mirror_and_a_mirror_without_a_header_item_are_reported() {
        let header = ffi_mirror::parse_header(SAMPLE_HEADER).unwrap();
        let mut declarations = sample_declarations(&ffi_mirror::render(&header).unwrap());
        declarations.structs.retain(|item| item.name != "ZeroPeer");
        declarations.enums.clear();
        declarations.enums.push(CsEnum {
            file: "Other.cs".to_owned(),
            name: "Other".to_owned(),
            underlying: "int".to_owned(),
            members: Vec::new(),
        });
        let problems = check(&header, &declarations);
        assert_eq!(
            problems,
            [
                "struct ZeroPeer of the header has 0 sequential structs of its name; it needs one",
                "enum ZeroStatus of the header has 0 C# enums of its name; it needs one",
                "Other.cs: the enum Other mirrors no enum of the header",
            ]
        );
    }

    #[test]
    fn the_committed_declarations_read() {
        let root = crate::docs::repo_root();
        let declarations = read_directory(&root.join(INTEROP)).unwrap();
        assert!(declarations
            .imports
            .iter()
            .any(|import| import.symbol == "zero_version"));
        assert!(declarations
            .enums
            .iter()
            .any(|item| item.name == "ZeroStatus"));
    }
}
