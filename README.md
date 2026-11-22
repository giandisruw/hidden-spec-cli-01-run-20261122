# mend

One patch tool for every AI edit format: a Node 22 CLI (standard library only) that applies
an AI-written edit to a tree of text files, changing every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

Formats: unified diffs (with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
JSON text-editor tool calls; `--format=auto` (the default) detects the format. Lines are
matched at the first of three tiers (exact, trailing whitespace ignored, leading and trailing
whitespace ignored with re-indentation), unless `--strict` asks for exact matching only.

## Files

- `main.ts` — the CLI, implementing SPEC.md in full.
- `runner.ts` — the kit's trial runner, kept as issued.
- `LICENSE` — MIT.

## Testing

Run the kit's practice set from the kit's starter directory (it runs this `main.ts`):

    node check.ts ../program/generator/practice.json

It prints every check that differs from the house reference, then the practice score.
