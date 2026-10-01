//! A small `--name value` argument reader for the binaries.

use std::collections::BTreeMap;

/// The parsed arguments: `--name value` pairs and `--flag` switches.
#[derive(Clone, Debug, Default)]
pub struct Args {
    values: BTreeMap<String, String>,
    flags: Vec<String>,
    positional: Vec<String>,
}

impl Args {
    /// Read the process arguments after the program name.
    ///
    /// # Arguments
    ///
    /// * `raw` - the arguments, program name excluded.
    ///
    /// # Returns
    ///
    /// The arguments; an option whose next word starts with `--` or is missing is a
    /// flag.
    #[must_use]
    pub fn parse(raw: impl IntoIterator<Item = String>) -> Self {
        let raw: Vec<String> = raw.into_iter().collect();
        let mut args = Args::default();
        let mut index = 0;
        while index < raw.len() {
            let word = &raw[index];
            if let Some(name) = word.strip_prefix("--") {
                if let Some((name, value)) = name.split_once('=') {
                    args.values.insert(name.to_owned(), value.to_owned());
                } else if raw
                    .get(index + 1)
                    .is_some_and(|next| !next.starts_with("--"))
                {
                    args.values.insert(name.to_owned(), raw[index + 1].clone());
                    index += 1;
                } else {
                    args.flags.push(name.to_owned());
                }
            } else {
                args.positional.push(word.clone());
            }
            index += 1;
        }
        args
    }

    /// The value of `--name`, when given.
    #[must_use]
    pub fn value(&self, name: &str) -> Option<&str> {
        self.values.get(name).map(String::as_str)
    }

    /// The value of `--name` parsed, or `fallback` when absent.
    ///
    /// # Arguments
    ///
    /// * `name` - the option name.
    /// * `fallback` - the default.
    ///
    /// # Errors
    ///
    /// The option's text when it does not parse.
    pub fn parsed<T: std::str::FromStr>(&self, name: &str, fallback: T) -> Result<T, String> {
        match self.value(name) {
            Some(text) => text
                .parse()
                .map_err(|_| format!("--{name} does not take `{text}`")),
            None => Ok(fallback),
        }
    }

    /// Whether `--name` was given as a switch.
    #[must_use]
    pub fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|flag| flag == name)
    }

    /// The words that are not options, in order.
    #[must_use]
    pub fn positional(&self) -> &[String] {
        &self.positional
    }
}

#[cfg(test)]
mod tests {
    use super::Args;

    #[test]
    fn options_flags_and_words_are_told_apart() {
        let args = Args::parse(
            [
                "load",
                "--connections",
                "256",
                "--pipeline=16",
                "--handoff",
                "--port",
                "8080",
            ]
            .map(String::from),
        );
        assert_eq!(args.positional(), ["load"]);
        assert_eq!(args.parsed("connections", 1usize), Ok(256));
        assert_eq!(args.parsed("pipeline", 1usize), Ok(16));
        assert_eq!(args.parsed("threads", 4usize), Ok(4));
        assert!(args.flag("handoff"));
        assert!(!args.flag("port"));
        assert_eq!(args.value("port"), Some("8080"));
        assert!(args.parsed::<usize>("port", 0).is_ok());
        assert!(Args::parse(["--n", "x"].map(String::from))
            .parsed::<usize>("n", 0)
            .is_err());
    }
}
