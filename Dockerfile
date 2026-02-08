FROM docker.io/node:24-alpine AS builder

RUN apk add --no-cache pnpm
RUN mkdir -p /temp/builder
COPY . /temp/builder/
WORKDIR /temp/builder
RUN pnpm install && pnpm run build

FROM docker.io/node:24-alpine AS result

LABEL org.opencontainers.image.title="Hollo"
LABEL org.opencontainers.image.description="Federated single-user \
microblogging software"
LABEL org.opencontainers.image.url="https://docs.hollo.social/"
LABEL org.opencontainers.image.source="https://github.com/fedify-dev/hollo"
LABEL org.opencontainers.image.licenses="AGPL-3.0-or-later"

RUN apk add --no-cache ffmpeg jq libstdc++ pnpm

COPY pnpm-lock.yaml package.json /app/
WORKDIR /app/
RUN pnpm install --frozen-lockfile --prod

COPY . /app/
COPY --from=builder /temp/builder/dist /app/dist
COPY src/public /app/dist/public

ARG VERSION
LABEL org.opencontainers.image.version="${VERSION}"
RUN \
  if [ "$VERSION" != "" ]; then \
    jq --arg version "$VERSION" '.version = $version' package.json > .pkg.json \
    && mv .pkg.json package.json; \
  fi

EXPOSE 3000
CMD ["pnpm", "run", "prod"]
