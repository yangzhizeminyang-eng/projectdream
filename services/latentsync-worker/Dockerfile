FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip git ffmpeg libgl1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/worker
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Mount a prepared LatentSync checkout and its checkpoints at /opt/LatentSync.
COPY app.py .
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
