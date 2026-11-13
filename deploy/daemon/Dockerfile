FROM rust:1.94-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /source
COPY Cargo.toml Cargo.lock ./
COPY apps/daemon ./apps/daemon
ARG TENET_BUILD_ID=development
ENV TENET_BUILD_ID=$TENET_BUILD_ID
RUN cargo build --locked --release --package tenetd

FROM scratch
COPY --from=build /source/target/release/tenetd /tenetd
