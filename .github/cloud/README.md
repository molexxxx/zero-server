# Working from a fresh clone

This folder holds everything a session needs to continue the project from a
clone of the repository alone: the rules, the design, the roadmap, the reports
of what has been done, and the current position. It is the tracked twin of the
owner's local planning folder. It is the plan, so planning vocabulary is
allowed here and nowhere else in the tree, and the wording lint
(`scripts/lint-wording.mjs`) is not run over it.

Read in this order, then start:

1. `RULES.md`: the engineering rules every change is held to. Non-negotiable.
2. `STATUS.md`: where the project is, the decisions already made, the next
   piece of work, and the commit protocol for working in chunks.
3. `ROADMAP.md`: the ordered work to feature parity with exit criteria and
   effort. `STATUS.md` names which entry is next.
4. `DESIGN.md`: the full design. Read the sections the roadmap entry cites
   before writing code for it. Section 20 lists the review resolutions, which
   are binding.
5. `research/`: the research the design rests on, one note per topic, each
   with the sources it fetched. Consult the note for the area you touch.
6. `architectures/`: the three proposals the design was synthesized from, for
   context only; where they disagree with `DESIGN.md`, the design wins.
7. `SCAFFOLD-REPORT.md` and, when present, `BRAND-REPORT.md`: what was built,
   every check and its outcome, every deviation and unverified item.
8. `BRAND-BRIEF.md`: the constraints for the logo, palette and README header.

What is not here, on purpose: the Node SDK's defect list from the 2026-09-27
audit (it describes unfixed problems in a published package and stays out of
any public tree), the raw TechEmpower extraction data (large JSON; the
summarized numbers are in `research/techempower.md`), and anything that names
the tooling a session runs in.

Keep this folder current: a session that changes the position of the project
updates `STATUS.md` in the same commit, so the next session resumes from the
truth.
