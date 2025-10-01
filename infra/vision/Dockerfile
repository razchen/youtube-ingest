FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libgl1 curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# (Optional) fetch face model at build time; or mount it at runtime
# Common YOLO face weights (community). Replace URL if you keep weights elsewhere.
RUN curl -L -o yolov8n-face.pt https://github.com/derronqi/yolo-face/releases/download/v0.0.0/yolov8n-face.pt || true

COPY app.py .
EXPOSE 8081
CMD ["python", "app.py"]
