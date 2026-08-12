FROM docker.io/node:24-bookworm-slim AS toolchain

ARG MISE_VERSION=2026.8.5
ARG TARGETARCH

ENV MISE_INSTALL_PATH=/usr/local/bin/mise \
  MISE_TRUSTED_CONFIG_PATHS=/app
RUN \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && case "$TARGETARCH" in \
    amd64) \
      mise_arch=x64; \
      mise_sha256=ee362b6d96c648e27325a8bc7ee866bde4fffc20c88c777c5eb5c3b5c6f3e226 \
      ;; \
    arm64) \
      mise_arch=arm64; \
      mise_sha256=d2bde76b1f87ab50b6f456e05332bb02de56a6bf3c5d19343cc3661e5d294681 \
      ;; \
    *) echo "Unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && curl --fail --silent --show-error --location \
    "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${mise_arch}" \
    --output "$MISE_INSTALL_PATH" \
  && echo "$mise_sha256  $MISE_INSTALL_PATH" | sha256sum --check \
  && chmod +x "$MISE_INSTALL_PATH" \
  && rm -rf /var/lib/apt/lists/*

COPY mise.toml /app/
WORKDIR /app/
RUN MISE_NO_HOOKS=1 mise install-into pnpm /opt/pnpm

FROM docker.io/node:24-bookworm-slim AS builder

RUN \
  apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg jq libatomic1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=toolchain /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json /app/
WORKDIR /app/
RUN pnpm install --frozen-lockfile

COPY . /app/
ARG VERSION
RUN \
  if [ "$VERSION" != "" ]; then \
    jq --arg version "$VERSION" '.version = $version' package.json > .pkg.json \
    && mv .pkg.json package.json \
    && pnpm install --offline --frozen-lockfile; \
  fi \
  && pnpm run build

FROM docker.io/node:24-bookworm-slim

LABEL org.opencontainers.image.title="Hollo"
LABEL org.opencontainers.image.description="Federated single-user \
microblogging software"
LABEL org.opencontainers.image.url="https://docs.hollo.social/"
LABEL org.opencontainers.image.source="https://github.com/fedify-dev/hollo"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"

RUN \
  apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg jq libatomic1 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=toolchain /opt/pnpm /opt/pnpm
ENV PATH="/opt/pnpm:${PATH}"

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json /app/
WORKDIR /app/
RUN pnpm install --frozen-lockfile --prod

COPY . /app/
COPY --from=builder /app/dist /app/dist

ARG VERSION
LABEL org.opencontainers.image.version="${VERSION}"
RUN \
  if [ "$VERSION" != "" ]; then \
    jq --arg version "$VERSION" '.version = $version' package.json > .pkg.json \
    && mv .pkg.json package.json \
    && pnpm install --offline --frozen-lockfile --prod; \
  fi

EXPOSE 3000
CMD ["pnpm", "run", "prod"]
