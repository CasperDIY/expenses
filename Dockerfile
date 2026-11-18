FROM python:3.12-alpine

# GitHub "owner/name" of the repository, used by the optional update check (filled in by the release workflow)
ARG EXPENSES_REPO=""

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=8080 \
    TZ=Europe/Ljubljana \
    EXPENSES_REPO=${EXPENSES_REPO}

RUN apk add --no-cache tzdata \
 && mkdir -p /data

WORKDIR /app
COPY app/ /app/
COPY VERSION /app/VERSION
# the database is /data/expenses.db (an existing /data/stroski.db from before the rename is used as is)
# starts as root, sets the owner of /data and then drops privileges to PUID/PGID (default 1000)

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/health || exit 1

CMD ["python", "server.py"]
