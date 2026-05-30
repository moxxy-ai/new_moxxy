---
"@moxxy/cli": patch
---

`moxxy init`: provider selection is now a single-choice picker instead of a multi-select.

Users reported the old multi-select step was unintuitive — it wasn't obvious you had to toggle items on/off, and a required multi-select with nothing checked reads as a dead end. The wizard now uses a single `select` (one provider, pre-highlighted, just press Enter), which also removes the now-redundant "which provider should be primary?" step and renumbers the remaining steps (model → 3, mode → 4, embedder → 5, plugin-security → 6, review → 7). The generated `moxxy.config.yaml` is unchanged in shape, and you can still add more providers afterward via config `fallbacks` or the provider-admin tools. This matches the desktop app's onboarding, which already used a single-provider picker.
