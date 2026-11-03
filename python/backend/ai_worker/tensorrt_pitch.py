from __future__ import annotations

import importlib
import logging
import sys
from pathlib import Path
from types import MappingProxyType

import torch


_CONTRACTS = MappingProxyType(
    {
        "pitch": ((128, 1024), (128, 360), torch.float32),
        "encoder": ((1, 128, 3000), (1, 1500, 1280), torch.float16),
    }
)


class _Engine:
    """Fixed-shape engines used only by the explicitly enabled local trials."""

    def __init__(self, directory: Path, kind: str = "pitch") -> None:
        self.input_shape, self.output_shape, self.input_dtype = _CONTRACTS[kind]
        packages = str(directory / "packages")
        if packages not in sys.path:
            sys.path.insert(0, packages)
        trt = importlib.import_module("tensorrt")
        self.logger = trt.Logger(trt.Logger.ERROR)
        self.runtime = trt.Runtime(self.logger)
        self.engine = self.runtime.deserialize_cuda_engine(
            (directory / f"{kind}.engine").read_bytes()
        )
        if self.engine is None:
            raise RuntimeError("TensorRT engine is incompatible with this runtime or GPU")
        self.context = self.engine.create_execution_context()
        if self.context is None or self.engine.num_io_tensors != 2:
            raise RuntimeError("Invalid TensorRT engine")
        self.input_name, self.output_name = [self.engine.get_tensor_name(i) for i in range(2)]
        if not (
            self.engine.get_tensor_mode(self.input_name) == trt.TensorIOMode.INPUT
            and tuple(self.engine.get_tensor_shape(self.input_name)) == self.input_shape
            and tuple(self.engine.get_tensor_shape(self.output_name)) == self.output_shape
            and self.engine.get_tensor_dtype(self.input_name)
            == {torch.float32: trt.float32, torch.float16: trt.float16}[self.input_dtype]
            and self.engine.get_tensor_dtype(self.output_name) == trt.float16
        ):
            raise RuntimeError("Unexpected TensorRT tensor contract")
        logging.getLogger(__name__).info("Experimental TensorRT %s enabled: %s", kind, directory)

    def _execute(self, frames: torch.Tensor) -> torch.Tensor:
        if (
            frames.device.type != "cuda"
            or frames.dtype != self.input_dtype
            or tuple(frames.shape) != self.input_shape
        ):
            raise ValueError("TensorRT input must match the CUDA engine tensor contract")
        output = torch.empty(self.output_shape, device=frames.device, dtype=torch.float16)
        self.context.set_tensor_address(self.input_name, frames.data_ptr())
        self.context.set_tensor_address(self.output_name, output.data_ptr())
        if not self.context.execute_async_v3(torch.cuda.current_stream(frames.device).cuda_stream):
            raise RuntimeError("TensorRT execution failed")
        return output


class TensorRTPitch(_Engine):
    """Full CREPE inference, preserving the original timeline and tail batch length."""

    def __call__(self, frames: torch.Tensor) -> torch.Tensor:
        count = len(frames)
        if not 0 < count <= 128 or frames.shape[1:] != (1024,):
            raise ValueError("TensorRT pitch requires 1..128 frames of 1024 samples")
        if count < 128:
            frames = torch.nn.functional.pad(frames, (0, 0, 0, 128 - count))
        return self._execute(frames.contiguous())[:count]


class TensorRTEncoder(torch.nn.Module):
    """Whisper audio encoder; the existing decoder and alignment heads remain native."""

    def __init__(self, directory: Path) -> None:
        super().__init__()
        self.execution = _Engine(directory, "encoder")

    def forward(self, mel: torch.Tensor) -> torch.Tensor:
        return self.execution._execute(mel.contiguous())
