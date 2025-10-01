FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DEBIAN_FRONTEND=noninteractive \
    FLAGS_use_mkldnn=false

# OS libs: libgomp is needed by Paddle; the X libs are harmless with headless OpenCV but kept for safety
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    libglib2.0-0 libsm6 libxext6 libxrender1 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Make sure we're copying the *right* requirements file
COPY requirements.txt /app/requirements.txt
RUN echo "=== requirements.txt in image ===" && sed -n '1,200p' /app/requirements.txt

# Install deps from requirements *and* ensure python-multipart is present in the same layer.
# Install paddleocr without deps (we've pinned headless OpenCV/Numpy ourselves).
RUN python -m pip install --upgrade pip \
 && python -m pip install --no-cache-dir -r /app/requirements.txt \
 && python -m pip install --no-cache-dir "python-multipart==0.0.20" \
 && python -m pip install --no-cache-dir "paddleocr==2.7.0.3" --no-deps \
 && python - <<'PY'
import numpy, cv2, paddle, multipart
from paddleocr import PaddleOCR
print("OK:", "multipart", getattr(multipart, "__version__", "?"),
      "| numpy", numpy.__version__,
      "| cv2", cv2.__version__)
PY

COPY server.py /app/server.py

EXPOSE 8000
CMD ["python","-m","uvicorn","server:app","--host","0.0.0.0","--port","8000"]
