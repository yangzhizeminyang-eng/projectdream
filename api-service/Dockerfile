FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
ARG APT_MIRROR=https://mirrors.aliyun.com/debian
ARG APT_SECURITY_MIRROR=https://mirrors.aliyun.com/debian-security
WORKDIR /app
COPY requirements.txt ./
RUN sed -i -E "s#https?://deb.debian.org/debian-security#${APT_SECURITY_MIRROR}#g; s#https?://deb.debian.org/debian#${APT_MIRROR}#g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && pip install --no-cache-dir --index-url "${PIP_INDEX_URL}" -r requirements.txt \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY app ./app
RUN useradd --create-home --uid 10002 app
USER app
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
