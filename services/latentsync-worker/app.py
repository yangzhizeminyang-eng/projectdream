import asyncio
import os
import subprocess
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import requests
from fastapi import FastAPI, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, HttpUrl


APP_ROOT = Path(__file__).resolve().parent
REPO_DIR = Path(os.getenv("LATENTSYNC_REPO_DIR", "/opt/LatentSync")).resolve()
OUTPUT_ROOT = Path(os.getenv("LATENTSYNC_OUTPUT_DIR", str(APP_ROOT / "outputs"))).resolve()
OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
CHECKPOINT = os.getenv("LATENTSYNC_CHECKPOINT", "checkpoints/latentsync_unet.pt")
UNET_CONFIG = os.getenv("LATENTSYNC_UNET_CONFIG", "configs/unet/stage2_512.yaml")
REQUIRE_CUDA = os.getenv("LATENTSYNC_REQUIRE_CUDA", "true").lower() not in {"0", "false", "no"}
TASK_TIMEOUT_SECONDS = int(os.getenv("LATENTSYNC_TASK_TIMEOUT_SECONDS", "1800"))
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="latentsync")
tasks: dict[str, dict] = {}


class LipSyncRequest(BaseModel):
    video_url: HttpUrl
    audio_url: HttpUrl
    prompt: str = ""
    duration_seconds: int = Field(default=6, ge=4, le=15)
    inference_steps: int = Field(default=20, ge=20, le=50)
    guidance_scale: float = Field(default=1.5, ge=1.0, le=3.0)
    seed: Optional[int] = None


app = FastAPI(title="ProjectDream LatentSync Worker", version="1.0.0")
app.mount("/outputs", StaticFiles(directory=str(OUTPUT_ROOT)), name="outputs")


def is_http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def has_cuda() -> bool:
    try:
        import torch

        return bool(torch.cuda.is_available())
    except Exception:
        return False


def download_input(url: str, target: Path) -> None:
    if not is_http_url(url):
        raise RuntimeError("LatentSync only accepts HTTP(S) media URLs")
    with requests.get(url, stream=True, timeout=(20, 300)) as response:
        response.raise_for_status()
        with target.open("wb") as output:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    output.write(chunk)


def public_output_url(task_id: str, request_base_url: str) -> str:
    base = os.getenv("LATENTSYNC_PUBLIC_BASE_URL", "").strip().rstrip("/")
    if not base:
        base = request_base_url.rstrip("/")
    return f"{base}/outputs/{task_id}/result.mp4"


def run_inference(task_id: str, payload: LipSyncRequest, base_url: str) -> None:
    task = tasks[task_id]
    work_dir = OUTPUT_ROOT / task_id
    work_dir.mkdir(parents=True, exist_ok=True)
    video_path = work_dir / "input.mp4"
    audio_path = work_dir / "input.wav"
    output_path = work_dir / "result.mp4"
    task["status"] = "running"
    task["progress"] = 8
    try:
        if REQUIRE_CUDA and not has_cuda():
            raise RuntimeError("LatentSync worker requires CUDA GPU, but torch.cuda.is_available() is false")
        task["progress"] = 12
        download_input(str(payload.video_url), video_path)
        download_input(str(payload.audio_url), audio_path)
        task["progress"] = 28
        command = [
            "python",
            "-m",
            "scripts.inference",
            "--unet_config_path",
            UNET_CONFIG,
            "--inference_ckpt_path",
            CHECKPOINT,
            "--inference_steps",
            str(payload.inference_steps),
            "--guidance_scale",
            str(payload.guidance_scale),
            "--enable_deepcache",
            "--video_path",
            str(video_path),
            "--audio_path",
            str(audio_path),
            "--video_out_path",
            str(output_path),
            "--temp_dir",
            str(work_dir / "temp"),
        ]
        if payload.seed is not None:
            command.extend(["--seed", str(payload.seed)])
        completed = subprocess.run(
            command,
            cwd=str(REPO_DIR),
            capture_output=True,
            text=True,
            timeout=TASK_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "LatentSync inference failed").strip()[-1200:]
            raise RuntimeError(detail)
        if not output_path.is_file() or output_path.stat().st_size == 0:
            raise RuntimeError("LatentSync completed without a non-empty output video")
        task["progress"] = 100
        task["status"] = "completed"
        task["video_url"] = public_output_url(task_id, base_url)
    except Exception as exc:
        task["status"] = "failed"
        task["progress"] = 100
        task["error"] = str(exc)


@app.get("/healthz")
def healthz():
    return {
        "ok": True,
        "cuda": has_cuda(),
        "cuda_required": REQUIRE_CUDA,
        "repo_exists": REPO_DIR.is_dir(),
        "checkpoint": str((REPO_DIR / CHECKPOINT).resolve()),
        "checkpoint_exists": (REPO_DIR / CHECKPOINT).is_file(),
    }


@app.post("/v1/lip-sync/tasks", status_code=202)
async def create_task(payload: LipSyncRequest, request: Request):
    task_id = uuid.uuid4().hex
    tasks[task_id] = {
        "task_id": task_id,
        "status": "queued",
        "progress": 0,
        "prompt": payload.prompt,
    }
    loop = asyncio.get_running_loop()
    loop.run_in_executor(executor, run_inference, task_id, payload, str(request.base_url))
    return tasks[task_id]


@app.get("/v1/lip-sync/tasks/{task_id}")
def get_task(task_id: str):
    task = tasks.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="LatentSync task not found")
    return task
