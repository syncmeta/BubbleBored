# Anthropic Skills — bundled presets

The `*.md` files in this directory are unmodified copies of skill definitions
from the upstream repository:

  https://github.com/anthropics/skills

Specifically, each file is a verbatim copy of the corresponding
`skills/<name>/SKILL.md` from that repository. Auxiliary resources
(`scripts/`, `references/`, `assets/`, `LICENSE.txt`, etc.) that ship with each
upstream skill are **not** vendored here — only the `SKILL.md` instruction
file, since PendingBot only injects skill instructions into the LLM system
prompt and does not execute the bundled tooling.

## License

These skills are licensed under the Apache License, Version 2.0. See:

  https://www.apache.org/licenses/LICENSE-2.0
  https://github.com/anthropics/skills/blob/main/skills/<name>/LICENSE.txt

Copyright © Anthropic, PBC. All rights reserved.

The `description:` field in each SKILL.md frontmatter is shown verbatim in the
PendingBot UI. The `source:` URL added by PendingBot's seeding code (see
`main/src/core/skills/presets.ts`) points to the upstream file.

## Bundled skills

| File | Upstream |
|------|----------|
| `skill-creator.md`     | https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md     |
| `mcp-builder.md`       | https://github.com/anthropics/skills/blob/main/skills/mcp-builder/SKILL.md       |
| `brand-guidelines.md`  | https://github.com/anthropics/skills/blob/main/skills/brand-guidelines/SKILL.md  |
| `internal-comms.md`    | https://github.com/anthropics/skills/blob/main/skills/internal-comms/SKILL.md    |
| `doc-coauthoring.md`   | https://github.com/anthropics/skills/blob/main/skills/doc-coauthoring/SKILL.md   |
| `theme-factory.md`     | https://github.com/anthropics/skills/blob/main/skills/theme-factory/SKILL.md     |

## Updating

To refresh the bundled copies against upstream:

```bash
for s in skill-creator mcp-builder brand-guidelines internal-comms doc-coauthoring theme-factory; do
  gh api -H "Accept: application/vnd.github.raw" \
    "repos/anthropics/skills/contents/skills/$s/SKILL.md" \
    > "main/prompts/skills/anthropic/$s.md"
done
```
