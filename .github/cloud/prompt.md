# Starting a session from the cloud

Paste this as the session's first instruction. It is one line so a shell
accepts it as a single argument.

```
Read .github/cloud/README.md in this repository and follow it exactly: read RULES.md and STATUS.md first, then continue from the next item STATUS.md names, working in verified chunks and committing and pushing each one to main as STATUS.md's commit protocol describes, updating STATUS.md whenever the position changes. Do not stop to ask whether to continue; the rules and the roadmap are the decisions.
```

With the command-line client the same text is the quoted argument after the
cloud flag.

If a session ends early, start the next one with the same text; STATUS.md
carries the position.
