// Subscription profiles, ported from the legacy fusion-setup profiles/*.json.
// Each profile carries the top-level model, small_model, and an agents map of
// role -> "provider/model-id". The provider display-name blocks from the JSON
// fragments are not needed by the config hook (auth/display live in opencode's
// own provider registry) and are dropped.

export const PROFILES = {
  chatgpt: {
    model: "openai/gpt-5.6-sol",
    small_model: "openai/gpt-5.6-luna",
    agents: {
      build: "openai/gpt-5.6-sol",
      sidekick: "openai/gpt-5.6-luna",
      explore: "openai/gpt-5.6-luna",
      reviewer: "openai/gpt-5.6-terra",
    },
  },
  "github-copilot": {
    model: "github-copilot/claude-sonnet-5",
    small_model: "github-copilot/gpt-5.6-luna",
    agents: {
      build: "github-copilot/claude-sonnet-5",
      sidekick: "github-copilot/gpt-5.6-luna",
      explore: "github-copilot/gpt-5.6-luna",
      research: "github-copilot/gemini-3.5-flash",
      reviewer: "github-copilot/gpt-5.6-sol",
    },
  },
  "opencode-go": {
    model: "opencode-go/kimi-k3",
    small_model: "opencode-go/deepseek-v4-flash",
    agents: {
      build: "opencode-go/kimi-k3",
      sidekick: "opencode-go/deepseek-v4-flash",
      explore: "opencode-go/deepseek-v4-flash",
      research: "opencode-go/deepseek-v4-pro",
      design: "opencode-go/qwen3.8-max",
      reviewer: "opencode-go/grok-4.5",
    },
  },
  "opencode-zen": {
    model: "opencode/claude-opus-5",
    small_model: "opencode/deepseek-v4-flash",
    agents: {
      build: "opencode/claude-opus-5",
      sidekick: "opencode/gpt-5.6-luna",
      explore: "opencode/deepseek-v4-flash",
      research: "opencode/claude-sonnet-5",
      design: "opencode/glm-5.2",
      reviewer: "opencode/gpt-5.6-sol",
    },
  },
  "opencode-zen-free": {
    model: "opencode/big-pickle",
    small_model: "opencode/deepseek-v4-flash-free",
    agents: {
      build: "opencode/big-pickle",
      sidekick: "opencode/mimo-v2.5-free",
      explore: "opencode/deepseek-v4-flash-free",
      vision: "opencode/mimo-v2.5-free",
    },
  },
};