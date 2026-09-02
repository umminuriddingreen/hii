#!/usr/bin/env python3
"""Generate print-ready HII QR campaign cards."""

from io import BytesIO
from pathlib import Path

import qrcode
from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import letter
from reportlab.lib.units import inch
from reportlab.pdfbase.pdfmetrics import stringWidth
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "output" / "pdf"
OUTPUT_FILE = OUTPUT_DIR / "hii-qr-cards-print.pdf"

PAGE_W, PAGE_H = letter
CARD_W = 3.5 * inch
CARD_H = 2 * inch
GRID_X = (PAGE_W - 2 * CARD_W) / 2
GRID_Y = (PAGE_H - 5 * CARD_H) / 2

INK = HexColor("#171717")
PAPER = HexColor("#F7F6F2")
BLUE = HexColor("#4457FF")
YELLOW = HexColor("#F3D757")
MUTED = HexColor("#66645F")

CAMPAIGNS = (
    {
        "name": "architecture",
        "eyebrow": "HII FOR ARCHITECTURE",
        "headline": ("YOUR CRIT", "SHOULD BE YOURS."),
        "body": "Record the conversation. Keep the decisions.\nTurn feedback into the next version - locally.",
        "cta": "SCAN TO MEET HII",
        "url": (
            "https://humaninformationinterface.com/"
            "?utm_source=print&utm_medium=qr&utm_campaign=campus_launch"
            "&utm_content=architecture_crit"
        ),
        "accent": BLUE,
    },
    {
        "name": "train",
        "eyebrow": "HII - YOUR PRIVATE AI",
        "headline": ("DON'T LOSE THE IDEA", "BETWEEN STOPS."),
        "body": "Talk it out. HII turns the thought into a note,\ntask, or project - on your computer.",
        "cta": "SCAN TO MEET HII",
        "url": (
            "https://humaninformationinterface.com/"
            "?utm_source=print&utm_medium=qr&utm_campaign=commuter_launch"
            "&utm_content=train_idea"
        ),
        "accent": YELLOW,
    },
)


def qr_image(url: str) -> ImageReader:
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_H,
        box_size=10,
        border=4,
    )
    qr.add_data(url)
    qr.make(fit=True)
    image = qr.make_image(fill_color="#171717", back_color="#FFFFFF")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    buffer.seek(0)
    return ImageReader(buffer)


def fit_text(c: canvas.Canvas, text: str, max_width: float, start: float, minimum: float) -> float:
    size = start
    while size > minimum and stringWidth(text, "Helvetica-Bold", size) > max_width:
        size -= 0.25
    return size


def draw_hii_mark(c: canvas.Canvas, x: float, y: float) -> None:
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 15)
    c.drawString(x, y, "hii")
    c.setFillColor(BLUE)
    c.circle(x + 20.5, y + 11.8, 1.8, stroke=0, fill=1)


def draw_card(c: canvas.Canvas, campaign: dict, x: float, y: float, qr: ImageReader) -> None:
    c.saveState()
    c.setFillColor(PAPER)
    c.rect(x, y, CARD_W, CARD_H, stroke=0, fill=1)

    accent_w = 5
    c.setFillColor(campaign["accent"])
    c.rect(x, y, accent_w, CARD_H, stroke=0, fill=1)

    left = x + 16
    top = y + CARD_H - 16
    qr_size = 77
    qr_x = x + CARD_W - qr_size - 12
    qr_y = y + 35
    text_width = qr_x - left - 10

    draw_hii_mark(c, left, top - 10)
    c.setFillColor(MUTED)
    c.setFont("Helvetica-Bold", 5.8)
    c.drawString(left + 30, top - 6, campaign["eyebrow"])

    headline_y = top - 31
    c.setFillColor(INK)
    for line in campaign["headline"]:
        size = fit_text(c, line, text_width, 14.5, 10.5)
        c.setFont("Helvetica-Bold", size)
        c.drawString(left, headline_y, line)
        headline_y -= size + 1.5

    c.setFillColor(MUTED)
    c.setFont("Helvetica", 6.4)
    body_y = headline_y - 5
    for line in campaign["body"].splitlines():
        c.drawString(left, body_y, line)
        body_y -= 8

    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 5.8)
    c.drawString(left, y + 16, "LOCAL AI. USER-OWNED FILES.")

    c.setFillColor(white)
    c.roundRect(qr_x - 4, qr_y - 4, qr_size + 8, qr_size + 8, 4, stroke=0, fill=1)
    c.drawImage(qr, qr_x, qr_y, qr_size, qr_size, preserveAspectRatio=True, mask="auto")
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 5.4)
    c.drawCentredString(qr_x + qr_size / 2, y + 24, campaign["cta"])
    c.setFont("Helvetica", 5.2)
    c.drawCentredString(qr_x + qr_size / 2, y + 15, "humaninformationinterface.com")
    c.restoreState()


def crop_marks(c: canvas.Canvas, x: float, y: float) -> None:
    length = 7
    gap = 2
    c.setStrokeColor(HexColor("#777777"))
    c.setLineWidth(0.35)
    segments = (
        (x - gap - length, y, x - gap, y),
        (x, y - gap - length, x, y - gap),
        (x + CARD_W + gap, y, x + CARD_W + gap + length, y),
        (x + CARD_W, y - gap - length, x + CARD_W, y - gap),
        (x - gap - length, y + CARD_H, x - gap, y + CARD_H),
        (x, y + CARD_H + gap, x, y + CARD_H + gap + length),
        (x + CARD_W + gap, y + CARD_H, x + CARD_W + gap + length, y + CARD_H),
        (x + CARD_W, y + CARD_H + gap, x + CARD_W, y + CARD_H + gap + length),
    )
    for x1, y1, x2, y2 in segments:
        c.line(x1, y1, x2, y2)


def generate() -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT_FILE), pagesize=letter, pageCompression=1)
    c.setTitle("HII QR Campaign Cards")
    c.setAuthor("HII")

    for campaign in CAMPAIGNS:
        qr = qr_image(campaign["url"])
        for row in range(5):
            for col in range(2):
                x = GRID_X + col * CARD_W
                y = PAGE_H - GRID_Y - (row + 1) * CARD_H
                draw_card(c, campaign, x, y, qr)
                crop_marks(c, x, y)
        c.showPage()

    c.save()
    return OUTPUT_FILE


if __name__ == "__main__":
    print(generate())
