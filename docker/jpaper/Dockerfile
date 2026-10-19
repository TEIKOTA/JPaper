# JPaper の子のコンテナの image（#452）。共通の agent-box:latest に pnpm・TeX Live・poppler を足す。手順は README.md。
# 版は ARG で固定する。TeX Live はホストと同じ 2025 の凍結版（tlnet-final）から入れる。
FROM agent-box:latest

ARG PNPM_VERSION=10.30.3
ARG TL_YEAR=2025
ARG TL_REPO=https://ftp.math.utah.edu/pub/tex/historic/systems/texlive/2025/tlnet-final
ARG TL_INSTALLER_SHA512=a307d7d11bcbd1f054ad0b0d476f7f12bc1a40d07445020edef8713b44453831d18a2f1722c3d2b0ea2e4fe6c06183a79d1c4049495113f412a9f5a570a8614d

USER root

RUN apt-get update \
 && apt-get install -y --no-install-recommends perl xz-utils wget poppler-utils \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "pnpm@${PNPM_VERSION}" && npm cache clean --force

RUN mkdir -p /opt/install-tl && cd /opt/install-tl \
 && curl -fsSL -o install-tl-unx.tar.gz "${TL_REPO}/install-tl-unx.tar.gz" \
 && echo "${TL_INSTALLER_SHA512}  install-tl-unx.tar.gz" | sha512sum -c - \
 && tar -xzf install-tl-unx.tar.gz --strip-components=1 \
 && printf '%s\n' \
      "selected_scheme scheme-basic" \
      "TEXDIR /usr/local/texlive/${TL_YEAR}" \
      "TEXMFLOCAL /usr/local/texlive/texmf-local" \
      "TEXMFSYSVAR /usr/local/texlive/${TL_YEAR}/texmf-var" \
      "TEXMFSYSCONFIG /usr/local/texlive/${TL_YEAR}/texmf-config" \
      "instopt_adjustpath 0" \
      "tlpdbopt_install_docfiles 0" \
      "tlpdbopt_install_srcfiles 0" \
      "tlpdbopt_autobackup 0" > texlive.profile \
 && perl ./install-tl --profile=texlive.profile --repository="${TL_REPO}" \
 && ln -s "/usr/local/texlive/${TL_YEAR}/bin/$(uname -m)-linux" /usr/local/texlive/bin \
 && cd / && rm -rf /opt/install-tl

ENV PATH=/usr/local/texlive/bin:${PATH}

RUN tlmgr install \
      collection-latexrecommended collection-latexextra collection-fontsrecommended \
      collection-langjapanese collection-luatex collection-mathscience collection-bibtexextra \
      collection-publishers collection-pictures collection-plaingeneric \
      latexmk newtx newpx libertine inconsolata fontaxes \
 && TEXMFVAR="/usr/local/texlive/${TL_YEAR}/texmf-var" luaotfload-tool -u \
 && mktexlsr

# 子は非 root・--read-only で動く。書ける /cache（repo ごとの volume）へ TeX の可変領域と pnpm の store を向ける。
ENV TEXMFVAR=/cache/texlive/texmf-var \
    TEXMFCONFIG=/cache/texlive/texmf-config \
    npm_config_store_dir=/cache/pnpm/store

RUN mkdir -p /cache/texlive /cache/pnpm && chown -R node:node /cache
USER node
