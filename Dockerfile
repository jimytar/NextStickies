# Reproducible build used by CI and ./build.sh. Targets:
#   app-out        Windows app: NextStickies.exe (needs the WebView2 runtime, built into Windows 10/11)
#   linux-out      Linux .deb (GTK 3 + WebKitGTK 4.1 come from the distribution)
#   installer-out  NSIS installer from the "appfiles" stage; CI overrides that stage with the signed app via
#                  `--build-context appfiles=<dir>` so the installer contains signed binaries.

# renovate: datasource=docker depName=node
FROM node:24-bookworm-slim AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run typecheck && npm test && npm run build

# Bookworm (glibc 2.36) so the Linux build also runs on older distributions.
# renovate: datasource=docker depName=golang
FROM golang:1.26-bookworm AS build
ARG VERSION=0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends libgtk-3-dev libwebkit2gtk-4.1-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /src/frontend/dist frontend/dist
RUN go vet -tags gtk3,production ./... && go test ./internal/...
RUN go run ./build/winres "${VERSION}" rsrc_windows_amd64.syso \
 && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -tags production -trimpath \
      -ldflags "-s -w -H windowsgui -X main.version=${VERSION}" -o /out/win/NextStickies.exe . \
 && go build -tags gtk3,production -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/nextstickies .
# .deb: binary, menu entry, icon
RUN set -e; p=/deb/nextstickies; \
    install -Dm755 /out/nextstickies "$p/usr/bin/nextstickies"; \
    install -Dm644 build/linux/nextstickies.desktop "$p/usr/share/applications/nextstickies.desktop"; \
    install -Dm644 build/icon.png "$p/usr/share/icons/hicolor/512x512/apps/nextstickies.png"; \
    install -Dm644 build/linux/control "$p/DEBIAN/control"; \
    sed -i "s/^Version: VERSION$/Version: ${VERSION}/" "$p/DEBIAN/control"; \
    mkdir -p /out/linux && dpkg-deb --root-owner-group --build "$p" "/out/linux/nextstickies_${VERSION}_amd64.deb"

FROM scratch AS app-out
COPY --from=build /out/win/ /

FROM scratch AS linux-out
COPY --from=build /out/linux/ /

FROM app-out AS appfiles

FROM debian:trixie-slim AS installer
ARG VERSION=0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends nsis && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY installer/ ./
COPY build/icon.ico ./app.ico
COPY --from=appfiles / ./app/
RUN mkdir -p /out && makensis -V2 -DVERSION=${VERSION} -DAPPDIR=app -DOUTFILE=/out/NextStickies-Setup-${VERSION}.exe NextStickies.nsi

FROM scratch AS installer-out
COPY --from=installer /out/ /
