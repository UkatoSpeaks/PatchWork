# text_utils (toy repo)

A small, working text-helpers package for testing Patchwork. Its test suite
passes. `ISSUE.md` asks for a new function, `slugify()`, with several precise
rules (accents, runs of separators, edge hyphens, empty results, TypeError),
so a coder working without the tester's tests is likely to miss one and the
verify/review retry loop gets exercised.

Don't add `slugify()` by hand in this copy. Patchwork's own test suite
(`tests/test_toy_repo.py`) checks that it is still missing and untested.
