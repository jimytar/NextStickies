# Reproducible build used by CI and ./build.sh. Targets:
#   app-out        Windows app files (win-unpacked; NextStickies.exe + Electron runtime)
#   appimage-out   Linux AppImage
#   installer-out  NSIS installer built from the "appfiles" stage; CI overrides that stage with the signed app via
#                  `--build-context appfiles=<dir>` so the installer contains signed binaries.

# Node + Wine: electron-builder needs Wine to stamp the icon/version into the Windows exe.
# renovate: datasource=docker depName=electronuserland/builder
FROM electronuserland/builder:24-wine AS build
ARG VERSION=0.0.0
WORKDIR /src/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run typecheck && npm test && npm run build
RUN npx electron-builder --win --linux -c.extraMetadata.version=${VERSION} --publish never

FROM scratch AS app-out
COPY --from=build /src/app/release/win-unpacked/ /

FROM scratch AS appimage-out
COPY --from=build /src/app/release/*.AppImage /

FROM app-out AS appfiles

FROM debian:trixie-slim AS installer
ARG VERSION=0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends nsis && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY installer/ ./
COPY app/build/icon.ico ./app.ico
COPY --from=appfiles / ./app/
RUN mkdir -p /out && makensis -V2 -DVERSION=${VERSION} -DAPPDIR=app -DOUTFILE=/out/NextStickies-Setup-${VERSION}.exe NextStickies.nsi

FROM scratch AS installer-out
COPY --from=installer /out/ /
