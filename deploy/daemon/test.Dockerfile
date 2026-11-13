# Isolated updater integration harness. No host Docker socket or privileged container.
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl util-linux && rm -rf /var/lib/apt/lists/*
CMD ["sleep", "infinity"]
