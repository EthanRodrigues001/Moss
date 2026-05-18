FROM rust:1.91-bookworm AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends pkg-config ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY Cargo.toml Cargo.lock* ./
COPY src ./src

RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    perl \
    latexmk \
    biber \
    tectonic \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    texlive-publishers \
    texlive-science \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/moss-compiler-backend /usr/local/bin/moss-compiler-backend

ENV PORT=8787
ENV MOSS_COMPILER_ENGINE=auto
ENV LATEXMK_BIN=latexmk
ENV TECTONIC_BIN=tectonic
ENV SYNCTEX_BIN=synctex
ENV ENABLE_XELATEX=false
ENV ENABLE_LUALATEX=false
ENV TECTONIC_CACHE_DIR=/tmp/moss-tectonic-cache
ENV COMPILE_WORK_DIR=/tmp/moss-compile-work
ENV COMPILE_ARTIFACT_DIR=/tmp/moss-compile-artifacts
ENV COMPILE_ARTIFACT_TTL_MS=600000

EXPOSE 8787

CMD ["moss-compiler-backend"]
