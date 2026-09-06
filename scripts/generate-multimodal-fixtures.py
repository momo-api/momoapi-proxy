from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tmp" / "multimodal-benchmark"
WIDTH, HEIGHT = A4


def font(size: int):
    candidates = [
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default()


def text_pdf(path: Path):
    pdf = canvas.Canvas(str(path), pagesize=A4)
    pdf.setTitle("MOMO multimodal benchmark - text PDF")
    pdf.setFont("Helvetica-Bold", 22)
    pdf.drawString(56, HEIGHT - 72, "MOMO Text PDF Benchmark")
    pdf.setFont("Helvetica", 14)
    lines = [
        "TEXT_PDF_CODE: MOMO-PDF-7429",
        "Invoice total: CNY 318.76",
        "Document date: 2026-09-06",
        "This page contains a normal selectable text layer.",
    ]
    y = HEIGHT - 120
    for line in lines:
        pdf.drawString(56, y, line)
        y -= 28
    pdf.save()


def scanned_page(path: Path):
    image = Image.new("RGB", (1240, 1754), "white")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((70, 80, 1170, 1670), radius=28, outline="#25324a", width=5)
    draw.text((120, 150), "SCANNED DOCUMENT", fill="#25324a", font=font(58))
    draw.line((120, 235, 1100, 235), fill="#7c8ba1", width=4)
    draw.text((120, 330), "SCAN_PDF_CODE: MOMO-SCAN-8642", fill="black", font=font(42))
    draw.text((120, 420), "Approved amount: CNY 527.41", fill="black", font=font(42))
    draw.text((120, 510), "Department: Quality Assurance", fill="black", font=font(38))
    draw.text((120, 650), "This PDF has no selectable text layer.", fill="#4b5563", font=font(34))
    image.save(path, "PNG")


def scanned_pdf(image_path: Path, pdf_path: Path):
    image = Image.open(image_path).convert("RGB")
    image.save(pdf_path, "PDF", resolution=150.0)


def chart_png(path: Path):
    image = Image.new("RGB", (1200, 760), "white")
    draw = ImageDraw.Draw(image)
    draw.text((55, 35), "Quarterly Units", fill="#111827", font=font(46))
    values = [("ALPHA", 12, "#60a5fa"), ("BETA", 47, "#34d399"), ("GAMMA", 31, "#f59e0b")]
    x = 120
    baseline = 630
    for label, value, color in values:
        bar_h = value * 9
        draw.rectangle((x, baseline - bar_h, x + 210, baseline), fill=color)
        draw.text((x + 70, baseline - bar_h - 55), str(value), fill="#111827", font=font(38))
        draw.text((x + 25, baseline + 25), label, fill="#111827", font=font(34))
        x += 340
    draw.line((70, baseline, 1130, baseline), fill="#111827", width=4)
    image.save(path, "PNG")


def mixed_pdf(chart_path: Path, pdf_path: Path):
    pdf = canvas.Canvas(str(pdf_path), pagesize=A4)
    pdf.setTitle("MOMO multimodal benchmark - mixed PDF")
    pdf.setFont("Helvetica-Bold", 21)
    pdf.drawString(48, HEIGHT - 62, "MOMO Mixed PDF Benchmark")
    pdf.setFont("Helvetica", 13)
    pdf.drawString(48, HEIGHT - 96, "MIXED_PDF_CODE: MOMO-MIX-1935")
    pdf.drawString(48, HEIGHT - 118, "The chart below is an embedded raster image, not selectable text.")
    pdf.drawImage(str(chart_path), 48, 150, width=500, height=317, preserveAspectRatio=True)
    pdf.setFillColor(HexColor("#4b5563"))
    pdf.setFont("Helvetica", 10)
    pdf.drawString(48, 126, "Question target: identify the highest bar and its value.")
    pdf.save()


def standalone_image(path: Path):
    image = Image.new("RGB", (1280, 800), "#eef2ff")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((70, 70, 1210, 730), radius=36, fill="white", outline="#4f46e5", width=6)
    draw.text((125, 130), "MOMO IMAGE BENCHMARK", fill="#312e81", font=font(55))
    draw.text((125, 270), "IMAGE_CODE: MOMO-IMG-5826", fill="#111827", font=font(45))
    draw.text((125, 370), "Blue circles: 4", fill="#111827", font=font(42))
    for i in range(4):
        x = 180 + i * 220
        draw.ellipse((x, 500, x + 110, 610), fill="#2563eb")
    image.save(path, "PNG")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    text_path = OUT / "text-layer.pdf"
    scan_image_path = OUT / "scan-page.png"
    scan_pdf_path = OUT / "scanned-image-only.pdf"
    chart_path = OUT / "chart.png"
    mixed_path = OUT / "mixed-text-chart.pdf"
    image_path = OUT / "standalone-image.png"

    text_pdf(text_path)
    scanned_page(scan_image_path)
    scanned_pdf(scan_image_path, scan_pdf_path)
    chart_png(chart_path)
    mixed_pdf(chart_path, mixed_path)
    standalone_image(image_path)

    manifest = {
        "text_pdf": str(text_path),
        "scanned_pdf": str(scan_pdf_path),
        "mixed_pdf": str(mixed_path),
        "image": str(image_path),
    }
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
