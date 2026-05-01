FROM nvidia/cuda:12.8.1-cudnn-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1

# build-essential gives Triton the C compiler it JIT-invokes when
# compiling fused kernels (Gemma 4 LoRA path triggers this on first
# forward). Without it: "Failed to find C compiler".
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3.11 python3.11-venv python3-pip git curl ca-certificates \
    build-essential \
    cmake libssl-dev libcurl4-openssl-dev \
    && rm -rf /var/lib/apt/lists/*

ENV CC=gcc CXX=g++

RUN python3.11 -m pip install --upgrade pip

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY run.py ./
CMD ["python3.11", "run.py"]
