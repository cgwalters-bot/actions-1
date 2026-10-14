# The shared workflow check (lint/), over this repository.
lint:
    {{ just_executable() }} --justfile lint/Justfile --working-directory . check

# The check's unit tests.
test-lint:
    {{ just_executable() }} --justfile lint/Justfile test
