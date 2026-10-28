---
"@moonshot-ai/kimi-code": minor
---

Add an experimental adaptive model router: classify each task by difficulty (T0-T3) and switch the main agent to the configured tier model before the turn starts, with bounded failure escalation, subagent model selection by task complexity, and a local per-session decision log. Enable with `KIMI_CODE_EXPERIMENTAL_MODEL_ROUTER=1` plus the `[model_router]` config section (see `model-router.example.toml`).
