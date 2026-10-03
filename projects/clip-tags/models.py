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
    # The export revision nicegal-server pins; the cache may hold other snapshots of the repo.
    revision: str
    dimensions: int
    size: int
    mean: tuple[float, float, float]
    std: tuple[float, float, float]
    resample: int
    # SigLIP2 was trained on lowercased text; its official tokenizer lowercases, the export does not.
    lowercase: bool = False
    context: int | None = None

    @property
    def directory(self) -> Path:
        return HUB / f"models--{self.repo.replace('/', '--')}" / "snapshots" / self.revision


CLIP_MEAN = (0.48145466, 0.4578275, 0.40821073)
CLIP_STD = (0.26862954, 0.26130258, 0.27577711)
MODELS = {
    m.short: m
    for m in [
        Model("facebook/metaclip-2-worldwide-l14", "l14",
              "bep256/metaclip-2-worldwide-l14-ONNX",
              "77e0837a2b1d7134c6d5678133a5abadaa933bde",
              768, 224, CLIP_MEAN, CLIP_STD, Image.BICUBIC),
        Model("facebook/metaclip-2-worldwide-b16", "b16",
              "bep256/metaclip-2-worldwide-b16-ONNX",
              "d96138fa24aa9cc3f46abf34a06f45f35e71bbba",
              512, 224, CLIP_MEAN, CLIP_STD, Image.BICUBIC),
        Model("facebook/metaclip-2-worldwide-b32", "b32",
              "bep256/metaclip-2-worldwide-b32-ONNX",
              "b4ee5fd6043c2b33df398eb0288a6282706c1687",
              512, 224, CLIP_MEAN, CLIP_STD, Image.BICUBIC),
        Model("google/siglip2-base-patch16-256", "siglip2",
              "bep256/siglip2-base-patch16-256-ONNX",
              "1fa886058822dbe657d57cfa4e5686c6b886f910",
              768, 256, (0.5,) * 3, (0.5,) * 3,
              Image.BILINEAR, lowercase=True),
        Model("facebook/PE-Core-B16-224", "pe-b16", "bep256/PE-Core-B16-224-ONNX",
              "548f910a9586cbd1144c6da29e26a53fce953e8e",
              1024, 224, (0.5,) * 3, (0.5,) * 3, Image.BILINEAR,
              context=32),
        Model("facebook/PE-Core-L14-336", "pe-l14", "bep256/PE-Core-L14-336-ONNX",
              "08d27aa8e48defea686014534f4a000c2d8a64df",
              1024, 336, (0.5,) * 3, (0.5,) * 3, Image.BILINEAR,
              context=32),
    ]
}


def unit(x: np.ndarray) -> np.ndarray:
    return x / np.linalg.norm(x, axis=-1, keepdims=True)


def session(path: Path, providers: list[str], batch: int | None) -> ort.InferenceSession:
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    if batch:
        options.add_free_dimension_override_by_name("batch", batch)
    if providers[0] == "DmlExecutionProvider":
        options.enable_mem_pattern = False
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        if batch:
            options.add_session_config_entry("session.disable_cpu_ep_fallback", "1")
            providers = ["DmlExecutionProvider"]
    return ort.InferenceSession(str(path), options, providers=providers)


class TextEncoder:
    def __init__(self, model: Model, providers: list[str] = PROVIDERS) -> None:
        self.lowercase = model.lowercase
        self.dimensions = model.dimensions
        self.tokenizer = Tokenizer.from_file(str(model.directory / "tokenizer.json"))
        self.fixed_batch = 64 if model.context else None
        if model.context:
            self.tokenizer.enable_truncation(max_length=model.context)
            self.tokenizer.enable_padding(length=model.context, pad_id=0, pad_token="!")
        self.session = session(model.directory / "text.onnx", providers, self.fixed_batch)
        self.inputs = {i.name for i in self.session.get_inputs()}

    def __call__(self, names: list[str], batch: int = 256) -> np.ndarray:
        """Unit vectors averaged over TEMPLATES."""
        out = np.zeros((len(names), self.dimensions), np.float32)
        batch = self.fixed_batch or batch
        for start in range(0, len(names), batch):
            chunk = names[start : start + batch]
            for template in TEMPLATES:
                texts = [template.format(t=t) for t in chunk]
                if self.lowercase:
                    texts = [t.lower() for t in texts]
                if self.fixed_batch and len(texts) < batch:
                    texts += [texts[-1]] * (batch - len(texts))
                enc = self.tokenizer.encode_batch(texts)
                feed = {"input_ids": np.array([e.ids for e in enc], np.int64)}
                if "attention_mask" in self.inputs:
                    feed["attention_mask"] = np.array([e.attention_mask for e in enc], np.int64)
                out[start : start + len(chunk)] += unit(self.session.run(None, feed)[0][:len(chunk)])
            if start % (batch * 32) == 0:
                print(f"  {start + len(chunk):,}/{len(names):,} labels", flush=True)
        return unit(out)


class ImageEncoder:
    def __init__(self, model: Model, providers: list[str] = PROVIDERS) -> None:
        self.model = model
        self.fixed_batch = 8 if model.context else None
        self.session = session(model.directory / "image.onnx", providers, self.fixed_batch)
        self.input = self.session.get_inputs()[0].name

    def tensor(self, data: bytes) -> np.ndarray:
        m = self.model
        image = Image.open(io.BytesIO(data)).convert("RGB").resize((m.size, m.size), m.resample)
        x = (np.asarray(image, np.float32) / 255 - np.array(m.mean, np.float32)) / np.array(
            m.std, np.float32
        )
        return x.transpose(2, 0, 1)

    def __call__(self, tensors: list[np.ndarray]) -> np.ndarray:
        count = len(tensors)
        if self.fixed_batch:
            if count > self.fixed_batch:
                raise ValueError("Image batch exceeds fixed shape")
            tensors = tensors + [tensors[-1]] * (self.fixed_batch - count)
        return unit(self.session.run(None, {self.input: np.stack(tensors)})[0][:count])
