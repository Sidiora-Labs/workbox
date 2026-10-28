# Workbox agents rootfs: the minimal rootfs plus Node, Claude Code and Codex, configured to run
# unattended because the Workbox sandbox is the isolation boundary. The pins equal the `agents`
# preset of packages/wb/src/presets.js (a unit test holds them together).
FROM debian:bookworm-slim
ARG NODE_VERSION=v22.23.4
ARG NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
ARG CLAUDE_CODE_VERSION=2.1.312
ARG CODEX_VERSION=0.165.0

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils util-linux procps ca-certificates curl git \
      less nano jq xz-utils gnupg \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

RUN mkdir -p /opt/workbox /run/workbox /var/lib/workbox-preset /workspace \
 && printf 'export PATH="/opt/workbox/bin:$PATH"\n' > /etc/profile.d/workbox.sh \
 && chmod 0644 /etc/profile.d/workbox.sh

RUN curl -fsSL --retry 3 -o /tmp/node.tar.xz \
      "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
 && tar -C /usr/local --strip-components=1 --no-same-owner -xJf /tmp/node.tar.xz \
 && rm -f /tmp/node.tar.xz

RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && rm -rf /root/.npm /tmp/*

# Claude Code: managed settings (highest precedence) turn off the auto-updater and non-essential
# traffic, start in bypassPermissions without its confirmation dialog and set IS_SANDBOX=1, the
# variable that lets bypassPermissions run as root (box sessions are uid 0).
RUN mkdir -p /etc/claude-code && cat > /etc/claude-code/managed-settings.json <<'EOF'
{
  "env": {
    "IS_SANDBOX": "1",
    "DISABLE_AUTOUPDATER": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "defaultMode": "bypassPermissions"
  },
  "skipDangerousModePermissionPrompt": true
}
EOF

# Claude Code first run: onboarding done and /workspace trusted; sign-in still needs a credential.
RUN cat > /root/.claude.json <<'EOF'
{
  "hasCompletedOnboarding": true,
  "projects": {
    "/workspace": {
      "hasTrustDialogAccepted": true
    }
  }
}
EOF

# Codex: its own sandbox off and approvals never, /workspace trusted, the full-access warning
# acknowledged, no update check or analytics, credentials kept in $CODEX_HOME/auth.json.
RUN mkdir -p /root/.codex && cat > /root/.codex/config.toml <<'EOF'
sandbox_mode = "danger-full-access"
approval_policy = "never"
check_for_update_on_startup = false
cli_auth_credentials_store = "file"

[analytics]
enabled = false

[notice]
hide_full_access_warning = true

[projects."/workspace"]
trust_level = "trusted"
EOF

WORKDIR /workspace
CMD ["/bin/bash"]
