FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    procps \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Released Stack installers under test still bootstrap Yarn-based checkouts.
# Current source checkouts provision their pinned pnpm through setup-pnpm.mjs.
RUN corepack enable && corepack prepare yarn@1.22.22 --activate

WORKDIR /work

COPY bin/ /opt/happier-npm-e2e/bin/
