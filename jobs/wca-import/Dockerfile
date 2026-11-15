# syntax=docker/dockerfile:1
# Build context = repo root:  docker build -f jobs/wca-import/Dockerfile -t cubr/wca-import:dev .
#
# A shell-script job: postgres:17-alpine already ships psql + pg_isready matching the server
# version; we add bash (the script), curl (download), unzip (stream files out of the zip) and
# jq (parse the export metadata JSON).
FROM postgres:17-alpine
ARG APP_VERSION=dev
RUN apk add --no-cache bash curl unzip jq
WORKDIR /opt/wca-import
COPY --chmod=0755 jobs/wca-import/import.sh ./import.sh
COPY jobs/wca-import/sql ./sql
# WORK_DIR holds the downloaded zip (~381 MB); on Kubernetes mount an emptyDir there.
ENV APP_VERSION=${APP_VERSION} WORK_DIR=/tmp/wca-import
# The image's unprivileged "postgres" user (uid 70); /tmp is world-writable.
USER postgres
ENTRYPOINT ["/opt/wca-import/import.sh"]
