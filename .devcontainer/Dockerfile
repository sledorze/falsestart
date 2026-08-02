FROM mcr.microsoft.com/devcontainers/typescript-node:1-22-bookworm

# Safer RUN pipes
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ============================================
# CORE TOOLS
# ============================================
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ripgrep=13.* && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ============================================
# PNPM (via corepack; exact version pinned by package.json "packageManager")
# ============================================
RUN corepack enable

# ============================================
# GITHUB CLI
# ============================================
RUN mkdir -p /etc/apt/keyrings && \
    wget --progress=dot:giga -O /etc/apt/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg && \
    chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh=2.* && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# ============================================
# GITLEAKS — secret scanning (lefthook pre-commit)
# ============================================
ENV GITLEAKS_VERSION="8.24.3"
RUN wget --progress=dot:giga "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" && \
    tar -xzf "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz" gitleaks && \
    chmod +x gitleaks && \
    mv gitleaks /usr/local/bin/ && \
    rm "gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"

# ============================================
# ZSH — developer shell (agnoster + plugins)
# ============================================
RUN sh -c "$(wget --progress=dot:giga -O- https://github.com/deluan/zsh-in-docker/releases/download/v1.2.1/zsh-in-docker.sh)" -- \
    -t agnoster \
    -p git \
    -p node \
    -p npm \
    -p https://github.com/zsh-users/zsh-autosuggestions \
    -p https://github.com/zsh-users/zsh-completions \
    -p https://github.com/zsh-users/zsh-syntax-highlighting

# ============================================
# HADOLINT — Dockerfile linter (lefthook pre-commit)
# ============================================
ENV HADOLINT_VERSION="2.12.0"
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "aarch64" ]; then HADOLINT_ARCH="arm64"; else HADOLINT_ARCH="x86_64"; fi && \
    wget --progress=dot:giga "https://github.com/hadolint/hadolint/releases/download/v${HADOLINT_VERSION}/hadolint-Linux-${HADOLINT_ARCH}" -O /usr/local/bin/hadolint && \
    chmod +x /usr/local/bin/hadolint
