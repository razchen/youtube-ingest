from fastapi import FastAPI, UploadFile, File
from paddleocr import PaddleOCR
from PIL import Image
import io, math

ocr = PaddleOCR(use_angle_cls=True, lang='en', det_db_box_thresh=0.6)  # good defaults
app = FastAPI()

@app.post("/ocr")
async def do_ocr(file: UploadFile = File(...)):
    img_bytes = await file.read()
    img = Image.open(io.BytesIO(img_bytes)).convert("RGB")
    w, h = img.size

    result = ocr.ocr(img_bytes, cls=True)
    # result: list per image -> list of [ [box, (text, conf)], ... ]
    words = []
    total_area = w * h
    boxes_area = 0.0
    text_out = []

    for line in (result[0] or []):
        box, (text, conf) = line
        # box is 4 points; compute bbox
        xs = [p[0] for p in box]; ys = [p[1] for p in box]
        x0, y0, x1, y1 = min(xs), min(ys), max(xs), max(ys)
        area = max(0, x1-x0) * max(0, y1-y0)
        boxes_area += area
        words.append({"bbox": [x0,y0,x1,y1], "text": text, "conf": conf})
        text_out.append(text)

    area_pct = (boxes_area / total_area) if total_area > 0 else None
    joined = " ".join(text_out)
    return {
        "text": joined,
        "charCount": len(joined.replace(" ", "")),
        "areaPct": area_pct,
        "words": words,
        "imageSize": {"width": w, "height": h},
    }
