/** A little-endian `F32` tensor viewed in place over its response buffer. */
export interface F32Tensor {
  shape: number[];
  data: Float32Array;
}

export interface Safetensors {
  metadata: Record<string, string>;
  tensors: Record<string, F32Tensor>;
}

type HeaderEntry = { dtype: string; shape: number[]; data_offsets: [number, number] };

/**
 * Read a safetensors buffer without copying tensor data. Only `F32` is supported. The writer pads
 * its header to 8 bytes, so every tensor is aligned for a `Float32Array` view.
 */
export function readSafetensors(buffer: ArrayBuffer): Safetensors {
  if (buffer.byteLength < 8) throw new Error("Tensor response is truncated.");
  const headerLength = Number(new DataView(buffer).getBigUint64(0, true));
  const dataStart = 8 + headerLength;
  if (dataStart > buffer.byteLength) throw new Error("Tensor response header is truncated.");
  const header = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)),
  ) as Record<string, HeaderEntry | Record<string, string>>;
  const { __metadata__: metadata = {}, ...entries } = header;
  const tensors: Record<string, F32Tensor> = {};
  for (const [name, entry] of Object.entries(entries) as Array<[string, HeaderEntry]>) {
    const [begin, end] = entry.data_offsets;
    const count = entry.shape.reduce((product, size) => product * size, 1);
    if (entry.dtype !== "F32" || end - begin !== count * 4 || dataStart + end > buffer.byteLength) {
      throw new Error(`Tensor ${name} is not a complete F32 tensor.`);
    }
    tensors[name] = {
      shape: entry.shape,
      data: new Float32Array(buffer, dataStart + begin, count),
    };
  }
  return { metadata: metadata as Record<string, string>, tensors };
}
