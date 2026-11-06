# LatentSync GPU Worker

This service is the ProjectDream adapter for the official ByteDance LatentSync repository.
It calls `python -m scripts.inference` with local downloaded media, then exposes the output
video for the Node server to persist.

## Prepare the model

```bash
git clone --depth 1 https://github.com/bytedance/LatentSync /opt/LatentSync
cd /opt/LatentSync
conda create -y -n latentsync python=3.10.13
conda activate latentsync
conda install -y -c conda-forge ffmpeg
pip install -r requirements.txt
```

Download the official checkpoint into `/opt/LatentSync/checkpoints/` and ensure the
configuration exists at `configs/unet/stage2_512.yaml`. The worker intentionally refuses
to process a task when CUDA is unavailable.

## Run

```bash
docker build -t projectdream-latentsync-worker services/latentsync-worker
docker run --gpus all --rm \
  -p 8080:8080 \
  -v /opt/LatentSync:/opt/LatentSync \
  -e LATENTSYNC_REPO_DIR=/opt/LatentSync \
  -e LATENTSYNC_PUBLIC_BASE_URL=http://YOUR_GPU_HOST:8080 \
  projectdream-latentsync-worker
```

Configure the Node service with:

```env
LIP_SYNC_PROVIDER=latentsync
LIP_SYNC_BASE_URL=http://YOUR_GPU_HOST:8080
LIP_SYNC_MODEL=LatentSync
LIP_SYNC_INFERENCE_STEPS=20
LIP_SYNC_GUIDANCE_SCALE=1.5
```

The worker is deliberately a separate service because LatentSync requires a CUDA runtime
and should not be installed into the Node application container.
