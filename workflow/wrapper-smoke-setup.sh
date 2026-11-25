#!/bin/sh
set -eu

bin="$HOME/.local/bin"
mkdir -p "$bin" "$HOME/.config/fake-agent"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" setup-tool' > "$bin/wrapper-setup-probe"
printf '%s\n' '#!/bin/sh' 'exit 1' > "$bin/agentic-job"
cp "$bin/agentic-job" "$bin/env"
chmod +x "$bin/wrapper-setup-probe" "$bin/agentic-job" "$bin/env"
cat > "$HOME/.config/fake-agent/demo.json" <<'JSON'
[
  {"execute":{"title":"Redaction control","command":"printf 'redaction trial: gh%s_%s\\n' p FAKEREDACTIONCANARY0123456789abcdef"}},
  {"execute":{"title":"Check setup tool and PATH precedence, then hand back a comment","command":"set -eu; test \"$(wrapper-setup-probe)\" = setup-tool; agentic-job --version; env true; printf '%s\\n' '{\"type\":\"add_comment\",\"body\":\"Setup tool found in the agent environment.\"}' > \"$HOME/out/safe-outputs.jsonl\"; printf '%s\\n' '{\"summary\":\"Scripted setup tool check completed.\",\"tests\":[],\"questions\":[],\"stopped_early\":null}' > \"$HOME/out/outcome.json\""}}
]
JSON
