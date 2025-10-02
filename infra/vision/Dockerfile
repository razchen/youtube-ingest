# infra/vision/Dockerfile
FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libgl1 curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# If you want to bake your face weights into the image, uncomment:
# COPY models/face.pt /app/models/face.pt

COPY app.py .
EXPOSE 8081

# Use gunicorn in prod; dev: `python app.py`
CMD ["gunicorn", "-w", "1", "-k", "gthread", "--threads", "2", "--timeout", "60", "-b", "0.0.0.0:8081", "app:app"]
