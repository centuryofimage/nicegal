"""Per-model settings for the image/text encoder pairs nicegal-server ships, matching its
preprocessing: images are squashed to the model's square input, text uses the export's tokenizer
as-is (padding, truncation and special tokens come from tokenizer.json)."""

import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image
from tokenizers import Tokenizer

HUB = Path.home() / ".cache/huggingface/hub"
PROVIDERS = ["DmlExecutionProvider", "CPUExecutionProvider"]
TEMPLATES = ["a photo of {t}.", "{t}"]


@dataclass(frozen=True)
class Model:
    id: str
    short: str
    repo: str
    dimensions: int
    size: int
    mean: tuple[float, float, float]
    std: tuple[float, float, float]
    resample: int
    # SigLIP2 was trained on lowercased text; its official tokenizer lowercases, the export does not.
    lowercase: bool = False

    @property
    def directory(self) -> Path:
        return next((HUB / f"models--{self.repo.replace('/', '--')}" / "snapshots").iterdir())


CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)
MODELS = {
    m.short: m
    for m in [
        Model("facebook/metaclip-2-worldwide-l14", "l14",
              "bep256/metaclip-2-worldwide-l14-ONNX", 768, 224, CLIP_MEAN, CLIP_STD, Image.BICUBIC),
        Model("facebook/metaclip-2-worldwide-b16", "b16",
              "bep256/metaclip-2-worldwide-b16-ONNX", 512, 224, CLIP_MEAN, CLIP_STD, Image.BICUBIC),
        Model("facebook/metaclip-2-worldwide-b32", "b32",
              "bep256/metaclip-2-worldwide-b32-ONNX", 512, 224, CLIP_MEAN, CLIP_STD, Image.BICUBIC),
        Model("google/siglip2-base-patch16-256", "siglip2",
              "bep256/siglip2-base-patch16-256-ONNX", 768, 256, (0.5,) * 3, (0.5,) * 3,
              Image.BILINEAR, lowercase=True),
    ]
}


def unit(x: np.ndarray) -> np.ndarray:
    return x / np.linalg.norm(x, axis=-1, keepdims=True)


class TextEncoder:
    def __init__(self, model: Model, providers: list[str] = PROVIDERS) -> None:
        self.lowercase = model.lowercase
        self.dimensions = model.dimensions
        self.tokenizer = Tokenizer.from_file(str(model.directory / "tokenizer.json"))
        self.session = ort.InferenceSession(str(model.directory / "text.onnx"), providers=providers)
        self.inputs = {i.name for i in self.session.get_inputs()}

    def __call__(self, names: list[str], batch: int = 256) -> np.ndarray:
        """Unit vectors averaged over TEMPLATES."""
        out = np.zeros((len(names), self.dimensions), np.float32)
        for start in range(0, len(names), batch):
            chunk = names[start : start + batch]
            for template in TEMPLATES:
                texts = [template.format(t=t) for t in chunk]
                if self.lowercase:
                    texts = [t.lower() for t in texts]
                enc = self.tokenizer.encode_batch(texts)
                feed = {"input_ids": np.array([e.ids for e in enc], np.int64)}
                if "attention_mask" in self.inputs:
                    feed["attention_mask"] = np.array([e.attention_mask for e in enc], np.int64)
                out[start : start + len(chunk)] += unit(self.session.run(None, feed)[0])
        return unit(out)


class ImageEncoder:
    def __init__(self, model: Model, providers: list[str] = PROVIDERS) -> None:
        self.model = model
        self.session = ort.InferenceSession(str(model.directory / "image.onnx"), providers=providers)
        self.input = self.session.get_inputs()[0].name

    def tensor(self, data: bytes) -> np.ndarray:
        m = self.model
        image = Image.open(io.BytesIO(data)).convert("RGB").resize((m.size, m.size), m.resample)
        x = (np.asarray(image, np.float32) / 255 - np.array(m.mean, np.float32)) / np.array(
            m.std, np.float32
        )
        return x.transpose(2, 0, 1)

    def __call__(self, tensors: list[np.ndarray]) -> np.ndarray:
        return unit(self.session.run(None, {self.input: np.stack(tensors)})[0])
