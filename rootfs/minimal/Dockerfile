# Workbox minimal rootfs. Exported with `docker export`, uid-shifted on the host and shared
# read-only by every sandbox. Toolchains are added inside each sandbox with `wb preset`.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils util-linux procps ca-certificates curl git \
      less nano jq xz-utils gnupg \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

RUN mkdir -p /opt/workbox /run/workbox /var/lib/workbox-preset /workspace \
 && printf 'export PATH="/opt/workbox/bin:$PATH"\n' > /etc/profile.d/workbox.sh \
 && chmod 0644 /etc/profile.d/workbox.sh

WORKDIR /workspace
CMD ["/bin/bash"]
