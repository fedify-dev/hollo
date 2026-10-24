FROM docker.io/node:26.12.1-bookworm-slim AS base

# Block both trust paths for the compromised eMudhra intermediates.
# Apply the distrust from Debian bug #1151413 even with older CA packages.
RUN \
  apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && sed -i \
    -e 's|^mozilla/emSign_ECC_Root_CA_-_G3\.crt$|!&|' \
    -e 's|^mozilla/Comodo_AAA_Services_root\.crt$|!&|' \
    /etc/ca-certificates.conf \
  && update-ca-certificates --fresh \
  && rm -rf /var/lib/apt/lists/*

FROM base AS toolchain

ARG MISE_VERSION=2026.10.18
ARG TARGETARCH

ENV MISE_INSTALL_PATH=/usr/local/bin/mise \
  MISE_TRUSTED_CONFIG_PATHS=/app
RUN \
  apt-get update \
  && apt-get install -y --no-install-recommends curl \
  && case "$TARGETARCH" in \
    amd64) \
      mise_arch=x64; \
      mise_sha256=e97c38973336aa2ff350fea50f47b412b266fe263b102b7200ff1e9b118c6942 \
      ;; \
    arm64) \
      mise_arch=arm64; \
      mise_sha256=3a3c72376687ba21a588d0f5a2c88c76f483fb6cdece7b0fc43d5e3132b08a52 \
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

FROM base AS builder

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
  rm -rf /app/docs \
  && if [ "$VERSION" != "" ]; then \
    jq --arg version "$VERSION" '.version = $version' package.json > .pkg.json \
    && mv .pkg.json package.json \
    && pnpm install --offline --frozen-lockfile; \
  fi \
  && pnpm run build

FROM base

LABEL org.opencontainers.image.title="Hollo"
LABEL org.opencontainers.image.description="Federated single-user \
microblogging software"
LABEL org.opencontainers.image.url="https://docs.hollo.social/"
LABEL org.opencontainers.image.source="https://github.com/fedify-dev/hollo"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"

RUN \
  apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg jq libatomic1 wget \
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
  rm -rf /app/docs \
  && if [ "$VERSION" != "" ]; then \
    jq --arg version "$VERSION" '.version = $version' package.json > .pkg.json \
    && mv .pkg.json package.json \
    && pnpm install --offline --frozen-lockfile --prod; \
  fi

EXPOSE 3000
CMD ["pnpm", "run", "prod"]
