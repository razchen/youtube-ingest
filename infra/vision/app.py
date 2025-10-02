from flask import Flask, request, jsonify
from PIL import Image
import numpy as np
import os
from ultralytics import YOLO

app = Flask(__name__)

# --- Object detector (COCO) ---
OBJ_WEIGHTS = os.environ.get("OBJ_WEIGHTS", "yolov8n.pt")
try:
    yolo_obj = YOLO(OBJ_WEIGHTS)
    app.logger.info(f"[vision] Object model: {OBJ_WEIGHTS}")
except Exception as e:
    app.logger.error(f"[vision] Failed to load {OBJ_WEIGHTS}: {e}. Falling back to yolov8n.pt")
    yolo_obj = YOLO("yolov8n.pt")

# --- Face detector ---
FACE_WEIGHTS = os.environ.get("FACE_WEIGHTS", "/models/yolov8n-face.pt")
yolo_face = None
try:
    if os.path.exists(FACE_WEIGHTS):
        yolo_face = YOLO(FACE_WEIGHTS)
        app.logger.info(f"[vision] Face model: {FACE_WEIGHTS}")
    else:
        app.logger.warning(f"[vision] Face weights not found at {FACE_WEIGHTS}; face detection disabled.")
except Exception as e:
    app.logger.warning(f"[vision] Failed to load face model '{FACE_WEIGHTS}': {e}. Face detection disabled.")

def rms_contrast(img_gray: Image.Image) -> float:
    arr = np.asarray(img_gray, dtype=np.float32)
    return float(arr.std() / 255.0)

def palette(img: Image.Image, k: int = 5):
    pal = img.convert('P', palette=Image.Palette.ADAPTIVE, colors=k)
    pal_rgb = pal.convert('RGB')
    w, h = pal_rgb.size
    step = max(1, int(np.sqrt(w*h) / 64))
    counts = {}
    for y in range(0, h, step):
        for x in range(0, w, step):
            c = pal_rgb.getpixel((x, y))
            counts[c] = counts.get(c, 0) + 1
    top = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)[:k]
    s = sum(c for _, c in top) or 1
    out = []
    for (r, g, b), cnt in top:
        out.append({"hex": "#{:02x}{:02x}{:02x}".format(r, g, b), "pct": cnt / s})
    return out

def coco_to_coarse(names):
    tags = set()
    veh = {'car','truck','bus','motorcycle','train'}
    if any(n in veh for n in names): tags.add('car')
    if 'person' in names: tags.add('person')
    return list(tags)

@app.post("/analyze")
def analyze():
    if 'image' not in request.files:
        return jsonify({"error": "image file required"}), 400

    f = request.files['image']
    img = Image.open(f.stream).convert('RGB')
    w, h = img.size

    # palette & contrast
    pal = palette(img, k=5)
    contrast = rms_contrast(img.convert('L'))

    # objects (YOLO12 detect)
    res = yolo_face.predict(img, imgsz=1280, conf=0.15, iou=0.5, verbose=False)

    names, raw = [], []
    for r in res:
        for b in r.boxes:
            cls = int(b.cls[0])
            name = r.names[cls]
            names.append(name)
            x1, y1, x2, y2 = map(float, b.xyxy[0])
            raw.append({"name": name, "conf": float(b.conf[0]),
                        "box": {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}})
    coarse = coco_to_coarse(names)
    
    # faces (optional YOLO-Face)
    faces_payload = {"enabled": yolo_face is not None, "count": 0}
    if yolo_face is not None:
        fr = yolo_face.predict(img, imgsz=1280, conf=0.35, iou=0.5, verbose=False)
        faces = []
        for r in fr:
            for b in r.boxes:
                x1, y1, x2, y2 = map(float, b.xyxy[0])
                area = (x2 - x1) * (y2 - y1)
                faces.append({"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1, "area": area})
        if faces:
            largest = max(faces, key=lambda f: f["area"])
            largest["areaPct"] = largest["area"] / (w * h)
            faces_payload.update({"count": len(faces), "largest": largest, "boxes": faces})

    return jsonify({
        "faces": faces_payload,
        "objects": {"tags": coarse, "raw": raw},
        "palette": pal,
        "contrast": contrast,
        "imageSize": {"width": w, "height": h}
    })
