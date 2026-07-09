"""Image generation and background removal microservice.

Standalone FastAPI service for image generation (diffusion) and background
removal (rembg). Supports multiple open-source models with GPU/CPU selection.
Runs on port 8423.
"""

import logging
import os
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration via environment variables
# ---------------------------------------------------------------------------
DIFFUSION_MODEL = os.getenv("DIFFUSION_MODEL", "stabilityai/stable-diffusion-2-1")
IMAGE_DEFAULT_WIDTH = int(os.getenv("IMAGE_DEFAULT_WIDTH", "512"))
IMAGE_DEFAULT_HEIGHT = int(os.getenv("IMAGE_DEFAULT_HEIGHT", "512"))
IMAGE_DEFAULT_STEPS = int(os.getenv("IMAGE_DEFAULT_STEPS", "20"))
IMAGE_DEFAULT_GUIDANCE = float(os.getenv("IMAGE_DEFAULT_GUIDANCE", "7.5"))
GENERATED_DIR = os.getenv("GENERATED_DIR", "generated")
UPLOAD_DIR = os.getenv("UPLOAD_DIR", "uploads")

os.makedirs(GENERATED_DIR, exist_ok=True)
os.makedirs(UPLOAD_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# Available image generation models
# ---------------------------------------------------------------------------

AVAILABLE_IMAGE_MODELS = [
    {
        "name": "stable-diffusion-2-1",
        "full_name": "stabilityai/stable-diffusion-2-1",
        "description": "Good quality — versatile default",
        "size": "~5 GB",
        "size_mb": 5000,
        "device": "gpu",
        "default_steps": 20,
    },
    {
        "name": "sdxl-turbo",
        "full_name": "stabilityai/sdxl-turbo",
        "description": "Fast SDXL — 1-4 step generation",
        "size": "~7 GB",
        "size_mb": 7000,
        "device": "gpu",
        "default_steps": 4,
    },
    {
        "name": "sdxl-base",
        "full_name": "stabilityai/stable-diffusion-xl-base-1.0",
        "description": "Highest quality — SDXL 1.0",
        "size": "~7 GB",
        "size_mb": 7000,
        "device": "gpu",
        "default_steps": 30,
    },
    {
        "name": "sd-1.5",
        "full_name": "runwayml/stable-diffusion-v1-5",
        "description": "Classic SD 1.5 — huge ecosystem",
        "size": "~4 GB",
        "size_mb": 4000,
        "device": "gpu",
        "default_steps": 20,
    },
    {
        "name": "flux-schnell",
        "full_name": "black-forest-labs/FLUX.1-schnell",
        "description": "FLUX.1 Schnell — fast, high quality",
        "size": "~12 GB",
        "size_mb": 12000,
        "device": "gpu",
        "default_steps": 4,
    },
    {
        "name": "segmind-tiny",
        "full_name": "segmind/tiny-sd",
        "description": "Tiny SD — CPU-friendly, compact",
        "size": "~1 GB",
        "size_mb": 1000,
        "device": "cpu",
        "default_steps": 25,
    },
    {
        "name": "small-sd",
        "full_name": "OFA-Sys/small-stable-diffusion-v0",
        "description": "Small SD — runs on CPU, decent quality",
        "size": "~1.5 GB",
        "size_mb": 1500,
        "device": "cpu",
        "default_steps": 25,
    },
]

_MODEL_MAP = {m["name"]: m for m in AVAILABLE_IMAGE_MODELS}
# Also allow lookup by full HuggingFace name
_FULL_NAME_MAP = {m["full_name"]: m for m in AVAILABLE_IMAGE_MODELS}


def _resolve_model_name(name: str) -> str:
    """Given a short name or full HF name, return the full HuggingFace model ID."""
    if name in _MODEL_MAP:
        return _MODEL_MAP[name]["full_name"]
    if name in _FULL_NAME_MAP:
        return name
    # Assume it's a full HuggingFace model path
    return name


def _short_name(full_name: str) -> str:
    """Given a full HF model name, return the short display name."""
    for m in AVAILABLE_IMAGE_MODELS:
        if m["full_name"] == full_name:
            return m["name"]
    return full_name


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ImageGenParams(BaseModel):
    prompt: str = Field(..., description="Text prompt for image generation")
    negative_prompt: str = Field(default="", description="Negative prompt")
    width: int = Field(default=IMAGE_DEFAULT_WIDTH, ge=64, le=2048)
    height: int = Field(default=IMAGE_DEFAULT_HEIGHT, ge=64, le=2048)
    steps: int = Field(default=IMAGE_DEFAULT_STEPS, ge=1, le=100)
    guidance_scale: float = Field(default=IMAGE_DEFAULT_GUIDANCE, ge=1.0, le=30.0)
    seed: int | None = Field(default=None, description="Random seed for reproducibility")


# ---------------------------------------------------------------------------
# Diffusion service singleton
# ---------------------------------------------------------------------------

class DiffusionService:
    """Image generation via diffusion models with multi-model support."""

    _instance: "DiffusionService | None" = None
    _pipeline = None
    _model_name: str = ""
    _device: str = "cpu"

    def __new__(cls) -> "DiffusionService":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    @property
    def is_loaded(self) -> bool:
        return self._pipeline is not None

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def device(self) -> str:
        return self._device

    @property
    def is_installed(self) -> bool:
        try:
            import torch  # noqa: F401
            import diffusers  # noqa: F401
            return True
        except ImportError:
            return False

    def load_model(self, model_name: str | None = None) -> dict:
        """Load a diffusion model by name. Returns status dict."""
        target = _resolve_model_name(model_name or DIFFUSION_MODEL)

        if self._pipeline is not None and self._model_name == target:
            return {"status": "already_loaded", "model": _short_name(target), "device": self._device}

        if not self.is_installed:
            msg = "diffusers and/or torch are not installed. Install with: pip install torch diffusers accelerate safetensors transformers"
            logger.warning(msg)
            return {"status": "not_installed", "error": msg, "install_command": "pip install torch diffusers accelerate"}

        # Unload current model if switching
        if self._pipeline is not None:
            self.unload()

        try:
            import torch
            from diffusers import AutoPipelineForText2Image

            has_cuda = torch.cuda.is_available()
            dtype = torch.float16 if has_cuda else torch.float32
            device = "cuda" if has_cuda else "cpu"

            logger.info("Loading diffusion model '%s' on %s...", target, device)

            self._pipeline = AutoPipelineForText2Image.from_pretrained(
                target,
                torch_dtype=dtype,
                variant="fp16" if has_cuda else None,
            )
            self._pipeline = self._pipeline.to(device)
            self._model_name = target
            self._device = device

            logger.info("Diffusion model '%s' loaded on %s.", target, device)
            return {"status": "loaded", "model": _short_name(target), "device": device}
        except Exception as e:
            logger.exception("Failed to load diffusion model '%s'", target)
            return {"status": "error", "error": str(e)}

    def unload(self) -> None:
        if self._pipeline is not None:
            del self._pipeline
            self._pipeline = None
            self._model_name = ""
            self._device = "cpu"
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
            logger.info("Diffusion pipeline unloaded.")

    async def generate(
        self,
        prompt: str,
        negative_prompt: str = "",
        width: int = 512,
        height: int = 512,
        steps: int = 20,
        guidance_scale: float = 7.5,
        seed: int | None = None,
    ) -> str:
        if not self.is_loaded:
            result = self.load_model()
            if result["status"] not in ("loaded", "already_loaded"):
                raise NotImplementedError(result.get("error", "Image generation not available"))

        import torch

        generator = torch.Generator(device=self._pipeline.device)
        if seed is not None:
            generator = generator.manual_seed(seed)

        image = self._pipeline(
            prompt=prompt,
            negative_prompt=negative_prompt if negative_prompt else None,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=guidance_scale,
            generator=generator,
        ).images[0]

        output_path = os.path.join(GENERATED_DIR, f"gen_{uuid.uuid4().hex[:8]}.png")
        image.save(output_path)
        return output_path


diffusion_service = DiffusionService()


# ===========================================================================
# PhotoMaker v1 persona tier  ("trained-look" durable likeness)
# ===========================================================================
#
# LICENSE GUARDRAIL — DO NOT "UPGRADE" THIS.
# ---------------------------------------------------------------------------
# This persona tier deliberately uses **PhotoMaker v1 ONLY**
# (TencentARC/PhotoMaker, checkpoint `photomaker-v1.bin`).
#
# PhotoMaker v1 is **Apache-2.0** and its ID encoder is **pure CLIP**
# (OpenCLIP ViT-H-14). It carries NO InsightFace and NO FLUX weights, which is
# the entire reason it is safe to bundle under Byorn's MIT distribution.
#
# NEVER introduce any of the following here (they carry non-commercial /
# research-only weights that would poison our MIT license):
#   - InstantID
#   - PuLID
#   - PhotoMaker **v2** (photomaker-v2.bin — pulls in InsightFace)
#   - UNO / USO
#   - insightface / antelopev2 / buffalo_* / inswapper  (any InsightFace)
#   - FLUX.1-dev  (or any FLUX-based identity pipeline)
#
# Base model is SDXL base 1.0 (stabilityai/stable-diffusion-xl-base-1.0),
# which is already in AVAILABLE_IMAGE_MODELS above.
# ===========================================================================

PHOTOMAKER_BASE_MODEL = "stabilityai/stable-diffusion-xl-base-1.0"
PHOTOMAKER_REPO_ID = "TencentARC/PhotoMaker"
PHOTOMAKER_CKPT = "photomaker-v1.bin"  # v1 ONLY — see license guardrail above
PHOTOMAKER_TRIGGER_WORD = "img"


def _ensure_trigger_word(prompt: str) -> str:
    """Guarantee PhotoMaker's trigger word is present in the prompt.

    PhotoMaker requires the class noun to be immediately followed by the token
    ``img`` (e.g. "a woman img", "a man img"). The public /persona/still contract
    accepts a *plain-English* prompt with no trigger word, so the service injects
    it here.

    Strategy: if the prompt already contains a standalone ``img`` token (word
    boundary, case-insensitive) we assume the caller placed it correctly and
    leave the prompt untouched. Otherwise we prepend a generic subject
    ``"a person img, "`` — this is robust for arbitrary scene prompts because
    PhotoMaker only needs the trigger token to exist so it can splice the
    reference identity into that subject.
    """
    import re

    if re.search(r"\bimg\b", prompt, flags=re.IGNORECASE):
        return prompt
    return f"a person {PHOTOMAKER_TRIGGER_WORD}, {prompt}"


def _style_strength_to_merge_step(style_strength: int, steps: int) -> int:
    """Map the 0-100 UI ``style_strength`` to PhotoMaker's ``start_merge_step``.

    PhotoMaker merges the reference identity into the denoising trajectory
    starting at ``start_merge_step``. A *later* merge means the base model has
    already committed more of the stylized composition before identity is
    blended in — so higher style_strength => later merge => more stylization /
    looser likeness. Lower style_strength => earlier merge => stricter likeness.

    Mapping: ``start_merge_step = round((style_strength / 100) * steps)`` clamped
    to ``[0, steps - 1]``. The official default of ~10 (out of 30 steps, i.e.
    ~33%) corresponds to the contract default style_strength=20 landing near
    steps*0.2; we keep the linear mapping and clamp so it can never exceed the
    step budget.
    """
    step = round((max(0, min(100, style_strength)) / 100.0) * steps)
    return max(0, min(step, max(0, steps - 1)))


class PhotoMakerService:
    """Durable persona generation via PhotoMaker v1 (pure-CLIP identity).

    Mirrors DiffusionService (lazy load, is_installed guard, load_model,
    generate, unload) but owns a SEPARATE pipeline
    (PhotoMakerStableDiffusionXLPipeline) since it is a different pipeline class.
    """

    _instance: "PhotoMakerService | None" = None
    _pipeline = None
    _device: str = "cpu"

    def __new__(cls) -> "PhotoMakerService":
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    @property
    def is_loaded(self) -> bool:
        return self._pipeline is not None

    @property
    def device(self) -> str:
        return self._device

    @property
    def is_installed(self) -> bool:
        try:
            import torch  # noqa: F401
            import diffusers  # noqa: F401
            import photomaker  # noqa: F401
            return True
        except ImportError:
            return False

    def load_model(self) -> dict:
        """Load SDXL base + PhotoMaker v1 adapter. Returns status dict."""
        if self._pipeline is not None:
            return {"status": "already_loaded", "model": "photomaker", "device": self._device}

        if not self.is_installed:
            msg = (
                "photomaker and/or torch/diffusers are not installed. "
                "Install with: pip install torch diffusers photomaker accelerate"
            )
            logger.warning(msg)
            return {
                "status": "not_installed",
                "error": msg,
                "install_command": "pip install torch diffusers photomaker accelerate",
            }

        try:
            import os as _os

            import torch
            from huggingface_hub import hf_hub_download
            from photomaker import PhotoMakerStableDiffusionXLPipeline

            has_cuda = torch.cuda.is_available()
            dtype = torch.float16 if has_cuda else torch.float32
            device = "cuda" if has_cuda else "cpu"

            logger.info("Loading PhotoMaker v1 (base '%s') on %s...", PHOTOMAKER_BASE_MODEL, device)

            # Download the PhotoMaker v1 checkpoint (Apache-2.0, pure CLIP ID encoder).
            photomaker_ckpt = hf_hub_download(
                repo_id=PHOTOMAKER_REPO_ID,
                filename=PHOTOMAKER_CKPT,
                repo_type="model",
            )

            pipe = PhotoMakerStableDiffusionXLPipeline.from_pretrained(
                PHOTOMAKER_BASE_MODEL,
                torch_dtype=dtype,
                use_safetensors=True,
                variant="fp16" if has_cuda else None,
            ).to(device)

            pipe.load_photomaker_adapter(
                _os.path.dirname(photomaker_ckpt),
                subfolder="",
                weight_name=_os.path.basename(photomaker_ckpt),
                trigger_word=PHOTOMAKER_TRIGGER_WORD,
            )
            # id_encoder is the OpenCLIP ViT-H-14 image encoder — move it too.
            if hasattr(pipe, "id_encoder"):
                pipe.id_encoder.to(device)
            pipe.fuse_lora()

            self._pipeline = pipe
            self._device = device

            logger.info("PhotoMaker v1 loaded on %s.", device)
            return {"status": "loaded", "model": "photomaker", "device": device}
        except Exception as e:
            logger.exception("Failed to load PhotoMaker v1")
            return {"status": "error", "error": str(e)}

    def unload(self) -> None:
        if self._pipeline is not None:
            del self._pipeline
            self._pipeline = None
            self._device = "cpu"
            try:
                import torch
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except ImportError:
                pass
            logger.info("PhotoMaker pipeline unloaded.")

    async def generate(
        self,
        images: list,
        prompt: str,
        negative_prompt: str = "",
        width: int = 1024,
        height: int = 1024,
        steps: int = 30,
        style_strength: int = 20,
        guidance_scale: float = 5.0,
        seed: int | None = None,
    ) -> str:
        """Generate a canonical persona still from anchor photos.

        ``images`` is a list of PIL.Image anchor photos (primary anchor first).
        Returns the output PNG path.
        """
        if not self.is_loaded:
            result = self.load_model()
            if result["status"] not in ("loaded", "already_loaded"):
                raise NotImplementedError(result.get("error", "Persona generation not available"))

        import torch

        trigger_prompt = _ensure_trigger_word(prompt)
        start_merge_step = _style_strength_to_merge_step(style_strength, steps)

        generator = torch.Generator(device=self._pipeline.device)
        if seed is not None:
            generator = generator.manual_seed(seed)

        image = self._pipeline(
            prompt=trigger_prompt,
            input_id_images=images,
            negative_prompt=negative_prompt if negative_prompt else None,
            width=width,
            height=height,
            num_inference_steps=steps,
            num_images_per_prompt=1,
            start_merge_step=start_merge_step,
            guidance_scale=guidance_scale,
            generator=generator,
        ).images[0]

        output_path = os.path.join(GENERATED_DIR, f"persona_{uuid.uuid4().hex[:8]}.png")
        image.save(output_path)
        return output_path


photomaker_service = PhotoMakerService()


# ---------------------------------------------------------------------------
# Rembg status check
# ---------------------------------------------------------------------------

def _check_rembg_available() -> bool:
    try:
        import rembg  # noqa: F401
        return True
    except ImportError:
        return False


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Byorn Image Service", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:3100",
        "http://localhost:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    """Return service health and model status."""
    diffusion_installed = diffusion_service.is_installed
    photomaker_installed = photomaker_service.is_installed
    rembg_available = _check_rembg_available()

    return {
        "status": "ok",
        "service": "image",
        "models": {
            "diffusion": {
                "loaded": diffusion_service.is_loaded,
                "model_name": _short_name(diffusion_service.model_name) if diffusion_service.is_loaded else None,
                "installed": diffusion_installed,
                "device": diffusion_service.device if diffusion_service.is_loaded else None,
            },
            "photomaker": {
                "loaded": photomaker_service.is_loaded,
                "installed": photomaker_installed,
                "device": photomaker_service.device if photomaker_service.is_loaded else None,
            },
            "rembg": {
                "available": rembg_available,
            },
        },
        "install_command": "pip install torch diffusers accelerate" if not diffusion_installed else None,
    }


@app.get("/models")
async def list_models():
    """List available image generation models with metadata."""
    active_full = diffusion_service.model_name if diffusion_service.is_loaded else None
    active_short = _short_name(active_full) if active_full else None
    device = diffusion_service.device if diffusion_service.is_loaded else "cpu"

    models = []
    for m in AVAILABLE_IMAGE_MODELS:
        is_active = m["full_name"] == active_full
        models.append({
            **m,
            "active": is_active,
            "device": device if is_active else m["device"],
        })
    return {"models": models, "active_model": active_short, "device": device}


@app.post("/generate")
async def generate_image(params: ImageGenParams):
    """Generate an image from a text prompt using the loaded diffusion model."""
    try:
        output_path = await diffusion_service.generate(
            prompt=params.prompt,
            negative_prompt=params.negative_prompt,
            width=params.width,
            height=params.height,
            steps=params.steps,
            guidance_scale=params.guidance_scale,
            seed=params.seed,
        )
        return FileResponse(
            path=output_path,
            media_type="image/png",
            filename=f"generated_{uuid.uuid4().hex[:8]}.png",
        )
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except Exception:
        logger.exception("Image generation failed")
        raise HTTPException(status_code=500, detail="Image generation failed.")


@app.post("/remove-bg")
async def remove_bg(file: UploadFile = File(...)):
    """Remove the background from an uploaded image."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided.")

    ext = Path(file.filename).suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp", ".bmp"}:
        raise HTTPException(status_code=400, detail="Unsupported image format.")

    upload_id = uuid.uuid4().hex[:8]
    upload_path = os.path.join(UPLOAD_DIR, f"rembg_{upload_id}{ext}")

    try:
        contents = await file.read()
        with open(upload_path, "wb") as f:
            f.write(contents)

        try:
            import asyncio
            from rembg import remove
            from PIL import Image

            output_path = os.path.join(GENERATED_DIR, f"nobg_{uuid.uuid4().hex[:8]}.png")

            def _remove_bg_sync() -> None:
                input_image = Image.open(upload_path)
                output_image = remove(input_image)
                output_image.save(output_path, "PNG")

            await asyncio.to_thread(_remove_bg_sync)

            return FileResponse(
                path=output_path,
                media_type="image/png",
                filename=f"nobg_{upload_id}.png",
            )
        except ImportError:
            raise HTTPException(
                status_code=501,
                detail="Install rembg to enable background removal.",
            )
    except HTTPException:
        raise
    except Exception:
        logger.exception("Background removal failed")
        raise HTTPException(status_code=500, detail="Background removal failed.")
    finally:
        if os.path.exists(upload_path):
            os.remove(upload_path)


@app.post("/persona/still")
async def persona_still(
    image: list[UploadFile] = File(..., description="1..N anchor photos (primary anchor first)"),
    prompt: str = Form(..., description="Persona scene prompt (plain English, no trigger word)"),
    negative_prompt: str = Form(default=""),
    width: int = Form(default=1024),
    height: int = Form(default=1024),
    steps: int = Form(default=30),
    style_strength: int = Form(default=20),
    guidance_scale: float = Form(default=5.0),
    seed: int | None = Form(default=None),
):
    """Generate a canonical persona still from many anchor photos (PhotoMaker v1).

    Durable "trained-look" likeness from 1..N reference photos of one person.
    The incoming ``prompt`` is plain English; the service injects PhotoMaker's
    required ``img`` trigger word (see ``_ensure_trigger_word``).
    """
    if not photomaker_service.is_installed:
        raise HTTPException(
            status_code=501,
            detail=(
                "PhotoMaker persona tier not available. "
                "Install with: pip install torch diffusers photomaker accelerate"
            ),
        )

    # Filter out empty file parts (some clients send a blank file field).
    files = [f for f in (image or []) if f is not None and f.filename]
    if not files:
        raise HTTPException(status_code=400, detail="At least one anchor image is required.")

    # Clamp dimensions defensively (SDXL portrait uses up to 1024x1536).
    width = max(64, min(width, 1536))
    height = max(64, min(height, 1536))

    upload_paths: list[str] = []
    try:
        from PIL import Image

        pil_images = []
        for f in files:
            ext = Path(f.filename).suffix.lower()
            if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
                raise HTTPException(status_code=400, detail=f"Unsupported image format: {ext}")
            upload_path = os.path.join(UPLOAD_DIR, f"anchor_{uuid.uuid4().hex[:8]}{ext}")
            contents = await f.read()
            with open(upload_path, "wb") as out:
                out.write(contents)
            upload_paths.append(upload_path)
            pil_images.append(Image.open(upload_path).convert("RGB"))

        output_path = await photomaker_service.generate(
            images=pil_images,
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            steps=steps,
            style_strength=style_strength,
            guidance_scale=guidance_scale,
            seed=seed,
        )
        return FileResponse(
            path=output_path,
            media_type="image/png",
            filename=f"persona_{uuid.uuid4().hex[:8]}.png",
        )
    except HTTPException:
        raise
    except NotImplementedError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except Exception:
        logger.exception("Persona still generation failed")
        raise HTTPException(status_code=500, detail="Persona still generation failed.")
    finally:
        for p in upload_paths:
            if os.path.exists(p):
                os.remove(p)


@app.post("/load")
async def load_model(model_name: str | None = None):
    """Load an image generation model by name. Downloads on first use.

    ``model_name=photomaker`` loads the SDXL base + PhotoMaker v1 persona tier;
    any other name routes to the standard diffusion pipeline.
    """
    if model_name == "photomaker":
        result = photomaker_service.load_model()
        if result["status"] == "not_installed":
            raise HTTPException(
                status_code=501,
                detail=result.get("error", "PhotoMaker libraries not installed"),
            )
        if result["status"] == "error":
            raise HTTPException(
                status_code=500,
                detail=result.get("error", "Failed to load PhotoMaker"),
            )
        return result

    result = diffusion_service.load_model(model_name)

    if result["status"] == "not_installed":
        raise HTTPException(
            status_code=501,
            detail=result.get("error", "Diffusion libraries not installed"),
        )
    if result["status"] == "error":
        raise HTTPException(
            status_code=500,
            detail=result.get("error", "Failed to load model"),
        )

    return result


@app.post("/test")
async def test_model():
    """Quick test: generate a tiny image to verify the model works."""
    if not diffusion_service.is_loaded:
        raise HTTPException(status_code=400, detail="No model loaded. Load a model first.")

    try:
        output_path = await diffusion_service.generate(
            prompt="test",
            width=64,
            height=64,
            steps=1,
            guidance_scale=1.0,
        )
        if os.path.exists(output_path):
            os.remove(output_path)

        return {
            "status": "ok",
            "model": _short_name(diffusion_service.model_name),
            "device": diffusion_service.device,
            "message": f"Model '{_short_name(diffusion_service.model_name)}' is working correctly.",
        }
    except Exception as e:
        logger.exception("Image test failed")
        raise HTTPException(status_code=500, detail=f"Test failed: {e}")


@app.post("/unload")
async def unload_model():
    """Unload the image generation and persona models and free memory."""
    diffusion_service.unload()
    photomaker_service.unload()
    return {"status": "success", "message": "Image model unloaded."}
