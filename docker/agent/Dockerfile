# 子セッション用の共通 image（#126）。各 repo は `FROM agent-box:<tag>` で自分の依存を足す。
# 版はホストで検証した組み合わせに固定し、上げるときは ARG だけを変える。
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.294
ARG CODEX_VERSION=0.161.0
ARG LEFTHOOK_VERSION=2.1.9

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git jq python3 ripgrep ruby less procps \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
      "lefthook@${LEFTHOOK_VERSION}" \
 && npm cache clean --force

# node image の uid 1000 ユーザーを使う。HOME はセッションごとの永続 directory を mount する。
# LANG が無いと POSIX ロケールになり、Ruby が UTF-8 の日本語ファイル（SKILL.md 等）を US-ASCII として読んで落ちる（#135）。
ENV HOME=/home/node AGENT_BOX=1 NPM_CONFIG_CACHE=/cache/npm PIP_CACHE_DIR=/cache/pip LANG=C.UTF-8
COPY entrypoint.sh inspect.sh /usr/local/lib/agent-box/
RUN chmod 0755 /usr/local/lib/agent-box/*.sh && mkdir -p /cache && chown node:node /cache
USER node
WORKDIR /work
ENTRYPOINT ["/usr/local/lib/agent-box/entrypoint.sh"]
