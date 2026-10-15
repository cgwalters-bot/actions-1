# The shared workflow check (lint/), over this repository.
lint:
    {{ just_executable() }} --justfile lint/Justfile --working-directory . check

# The check's unit tests.
test-lint:
    {{ just_executable() }} --justfile lint/Justfile test

# Reusable event-review admission and credential-boundary regressions.
test-review:
    node --test workflow/review.test.cjs
