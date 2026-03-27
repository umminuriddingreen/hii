#!/usr/bin/env python3
"""
HII Document Generator

Creates PDF and PPTX reports from markdown + images.
Designed to pull renders from ComfyUI output, organize them,
and assemble into submission-ready documents.

Supports:
- PDF via fpdf2 (lightweight, no wkhtmltopdf needed)
- PDF via weasyprint (HTML/CSS to PDF, better styling)
- PPTX via python-pptx (PowerPoint presentations)

Usage:
    python -m engine.tools.docgen pdf --md report.md --images-dir ./renders --output report.pdf
    python -m engine.tools.docgen pptx --md report.md --images-dir ./renders --output report.pptx
    python -m engine.tools.docgen collect-renders --comfyui-output ~/Documents/ComfyUI/output --dest ./chains
"""

import argparse
import json
import os
import re
import shutil
import glob
from pathlib import Path
from datetime import datetime


def collect_comfyui_renders(comfyui_output: str, dest_dir: str, prefix_filter: str = None) -> list[str]:
    """
    Collect renders from ComfyUI output directory and organize into chain folders.
    Returns list of collected file paths.
    """
    src = Path(comfyui_output)
    dst = Path(dest_dir)
    collected = []

    # Get all image and 3D files from ComfyUI output
    extensions = {'.png', '.jpg', '.jpeg', '.webp', '.glb', '.obj', '.stl', '.ply', '.gltf'}
    files = sorted(src.iterdir(), key=lambda f: f.stat().st_mtime, reverse=True)

    for f in files:
        if f.suffix.lower() in extensions:
            if prefix_filter and not f.name.lower().startswith(prefix_filter.lower()):
                continue
            target = dst / f.name
            shutil.copy2(f, target)
            collected.append(str(target))
            print(f"  Collected: {f.name}")

    print(f"\nTotal: {len(collected)} files collected to {dest_dir}")
    return collected


def md_to_pdf_fpdf(md_path: str, output_path: str, images_dir: str = None, title: str = None):
    """Generate PDF from markdown using fpdf2. Handles images and basic formatting."""
    from fpdf import FPDF

    md_text = Path(md_path).read_text()
    img_dir = Path(images_dir) if images_dir else Path(md_path).parent

    pdf = FPDF()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()

    # Title page
    if title:
        pdf.set_font("Helvetica", "B", 28)
        pdf.ln(60)
        pdf.cell(0, 15, title, align="C", new_x="LMARGIN", new_y="NEXT")
        pdf.ln(10)
        pdf.set_font("Helvetica", "", 14)
        pdf.cell(0, 10, datetime.now().strftime("%B %Y"), align="C", new_x="LMARGIN", new_y="NEXT")
        pdf.add_page()

    # Parse markdown line by line
    lines = md_text.split('\n')
    i = 0
    while i < len(lines):
        line = lines[i]

        # Headers
        if line.startswith('# '):
            pdf.set_font("Helvetica", "B", 22)
            pdf.ln(8)
            pdf.multi_cell(0, 10, line[2:].strip())
            pdf.ln(4)
        elif line.startswith('## '):
            pdf.set_font("Helvetica", "B", 16)
            pdf.ln(6)
            pdf.multi_cell(0, 8, line[3:].strip())
            pdf.ln(3)
        elif line.startswith('### '):
            pdf.set_font("Helvetica", "B", 13)
            pdf.ln(4)
            pdf.multi_cell(0, 7, line[4:].strip())
            pdf.ln(2)
        elif line.startswith('---'):
            pdf.ln(3)
            pdf.line(pdf.get_x(), pdf.get_y(), pdf.get_x() + 170, pdf.get_y())
            pdf.ln(3)
        elif line.startswith('|') and '|' in line[1:]:
            # Table - collect all table rows
            table_lines = []
            while i < len(lines) and lines[i].startswith('|'):
                if not lines[i].replace('-', '').replace('|', '').replace(' ', '') == '':
                    table_lines.append(lines[i])
                i += 1
            i -= 1  # back up one since outer loop will increment

            if table_lines:
                pdf.set_font("Helvetica", "", 9)
                for tl in table_lines:
                    cells = [c.strip() for c in tl.split('|')[1:-1]]
                    col_w = 170 / max(len(cells), 1)
                    for c in cells:
                        # Bold headers
                        if cells == [c.strip() for c in table_lines[0].split('|')[1:-1]]:
                            pdf.set_font("Helvetica", "B", 9)
                        else:
                            pdf.set_font("Helvetica", "", 9)
                        pdf.cell(col_w, 6, c[:40], border=1)
                    pdf.ln()
                pdf.ln(3)
        elif re.match(r'!\[.*\]\((.*)\)', line):
            # Image
            m = re.match(r'!\[.*\]\((.*)\)', line)
            img_path = m.group(1)
            if not os.path.isabs(img_path):
                img_path = str(img_dir / img_path)
            if os.path.exists(img_path):
                try:
                    w = min(170, 170)  # max width
                    pdf.image(img_path, w=w)
                    pdf.ln(3)
                except Exception as e:
                    pdf.set_font("Helvetica", "I", 9)
                    pdf.cell(0, 5, f"[Image: {img_path} - {e}]", new_x="LMARGIN", new_y="NEXT")
            else:
                pdf.set_font("Helvetica", "I", 9)
                pdf.cell(0, 5, f"[Image not found: {img_path}]", new_x="LMARGIN", new_y="NEXT")
        elif line.startswith('- ') or line.startswith('* '):
            pdf.set_font("Helvetica", "", 11)
            bullet_text = line[2:].strip()
            # Handle bold within bullets
            bullet_text = re.sub(r'\*\*(.*?)\*\*', r'\1', bullet_text)
            pdf.cell(8, 6, chr(8226))  # bullet char
            pdf.multi_cell(162, 6, bullet_text)
        elif line.strip() == '':
            pdf.ln(3)
        else:
            # Regular paragraph
            pdf.set_font("Helvetica", "", 11)
            # Strip markdown bold/italic
            clean = re.sub(r'\*\*(.*?)\*\*', r'\1', line)
            clean = re.sub(r'\*(.*?)\*', r'\1', clean)
            clean = re.sub(r'`(.*?)`', r'\1', clean)
            if clean.strip():
                pdf.multi_cell(0, 6, clean.strip())

        i += 1

    pdf.output(output_path)
    print(f"PDF saved: {output_path}")
    return output_path


def md_to_pdf_weasy(md_path: str, output_path: str, images_dir: str = None):
    """Generate styled PDF from markdown via HTML using weasyprint."""
    import markdown
    from weasyprint import HTML

    md_text = Path(md_path).read_text()
    img_dir = Path(images_dir) if images_dir else Path(md_path).parent

    # Convert markdown to HTML
    html_body = markdown.markdown(md_text, extensions=['tables', 'fenced_code'])

    # Fix relative image paths to absolute
    html_body = re.sub(
        r'src="(?!http)([^"]+)"',
        lambda m: f'src="file://{img_dir / m.group(1)}"',
        html_body
    )

    css = """
    @page { size: letter; margin: 1in; }
    body {
        font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
        font-size: 11pt; line-height: 1.6; color: #1a1a1a;
    }
    h1 { font-size: 24pt; margin-top: 30pt; border-bottom: 2px solid #333; padding-bottom: 6pt; }
    h2 { font-size: 18pt; margin-top: 24pt; color: #2c3e50; }
    h3 { font-size: 14pt; margin-top: 18pt; color: #34495e; }
    table { border-collapse: collapse; width: 100%; margin: 12pt 0; }
    th, td { border: 1px solid #ddd; padding: 6pt 10pt; text-align: left; font-size: 10pt; }
    th { background: #f5f5f5; font-weight: bold; }
    img { max-width: 100%; margin: 10pt 0; }
    blockquote { border-left: 3px solid #ccc; padding-left: 12pt; color: #555; }
    hr { border: none; border-top: 1px solid #ccc; margin: 20pt 0; }
    code { background: #f4f4f4; padding: 2pt 4pt; font-size: 10pt; }
    """

    full_html = f"""<!DOCTYPE html>
    <html><head><style>{css}</style></head>
    <body>{html_body}</body></html>"""

    HTML(string=full_html, base_url=str(img_dir)).write_pdf(output_path)
    print(f"PDF saved: {output_path}")
    return output_path


def md_to_pptx(md_path: str, output_path: str, images_dir: str = None):
    """Generate PowerPoint from markdown. Each ## becomes a slide."""
    from pptx import Presentation
    from pptx.util import Inches, Pt
    from pptx.enum.text import PP_ALIGN

    md_text = Path(md_path).read_text()
    img_dir = Path(images_dir) if images_dir else Path(md_path).parent

    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    # Split by ## headers
    sections = re.split(r'^## ', md_text, flags=re.MULTILINE)

    # Title slide from first section
    if sections:
        first = sections[0]
        title_match = re.search(r'^# (.+)', first, re.MULTILINE)
        slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank
        if title_match:
            txBox = slide.shapes.add_textbox(Inches(1), Inches(2.5), Inches(11), Inches(2))
            tf = txBox.text_frame
            tf.text = title_match.group(1).strip()
            tf.paragraphs[0].font.size = Pt(44)
            tf.paragraphs[0].font.bold = True
            tf.paragraphs[0].alignment = PP_ALIGN.CENTER

    # Content slides
    for section in sections[1:]:
        lines = section.strip().split('\n')
        title = lines[0].strip() if lines else "Untitled"

        slide = prs.slides.add_slide(prs.slide_layouts[6])

        # Title
        txBox = slide.shapes.add_textbox(Inches(0.5), Inches(0.3), Inches(12), Inches(1))
        tf = txBox.text_frame
        tf.text = title
        tf.paragraphs[0].font.size = Pt(28)
        tf.paragraphs[0].font.bold = True

        # Content
        content_lines = lines[1:]
        content_text = '\n'.join(content_lines).strip()

        # Check for images
        img_matches = re.findall(r'!\[.*?\]\((.+?)\)', content_text)
        if img_matches:
            for img_path in img_matches[:2]:  # max 2 images per slide
                if not os.path.isabs(img_path):
                    img_path = str(img_dir / img_path)
                if os.path.exists(img_path):
                    try:
                        slide.shapes.add_picture(img_path, Inches(1), Inches(1.5), width=Inches(5))
                    except Exception:
                        pass

        # Text content (strip images from text)
        clean_text = re.sub(r'!\[.*?\]\(.+?\)', '', content_text).strip()
        if clean_text:
            txBox2 = slide.shapes.add_textbox(Inches(0.5), Inches(1.5), Inches(12), Inches(5.5))
            tf2 = txBox2.text_frame
            tf2.word_wrap = True
            # Add paragraphs
            for para_text in clean_text.split('\n'):
                p = tf2.add_paragraph()
                p.text = re.sub(r'\*\*(.+?)\*\*', r'\1', para_text.strip())
                p.font.size = Pt(14)

    prs.save(output_path)
    print(f"PPTX saved: {output_path}")
    return output_path


def insert_images_into_md(md_path: str, images_dir: str, chain_mapping: dict = None):
    """
    Insert image references into markdown report template.
    chain_mapping: {"chain1": ["render1.png", "render2.png"], ...}
    """
    md_text = Path(md_path).read_text()
    img_dir = Path(images_dir)

    if chain_mapping is None:
        # Auto-detect: look for chain folders in images_dir
        chain_mapping = {}
        for d in sorted(img_dir.iterdir()):
            if d.is_dir() and d.name.startswith('chain'):
                outputs = list((d / 'ai_output').glob('*')) if (d / 'ai_output').exists() else []
                refined = list((d / 'refined').glob('*')) if (d / 'refined').exists() else []
                inputs_imgs = list((d / 'inputs').glob('*')) if (d / 'inputs').exists() else []
                chain_mapping[d.name] = {
                    'inputs': [str(f) for f in inputs_imgs],
                    'ai_output': [str(f) for f in outputs],
                    'refined': [str(f) for f in refined],
                }

    # Replace [INSERT RENDERS] placeholders with actual image references
    for chain_name, files in chain_mapping.items():
        if isinstance(files, dict):
            for f in files.get('inputs', []):
                md_text = md_text.replace(
                    f'`{chain_name}/inputs/',
                    f'![Input]({f})\n`{chain_name}/inputs/', 1)
            for f in files.get('ai_output', []):
                md_text = md_text.replace(
                    '[INSERT RENDERS]',
                    f'![AI Output]({f})', 1)
            for f in files.get('refined', []):
                md_text = md_text.replace(
                    '[INSERT REFINED RENDERS]',
                    f'![Refined]({f})', 1)

    Path(md_path).write_text(md_text)
    print(f"Updated: {md_path}")
    return md_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="HII Document Generator")
    sub = parser.add_subparsers(dest="command")

    # PDF
    pdf_p = sub.add_parser("pdf")
    pdf_p.add_argument("--md", required=True, help="Markdown source file")
    pdf_p.add_argument("--output", "-o", required=True, help="Output PDF path")
    pdf_p.add_argument("--images-dir", help="Directory containing images")
    pdf_p.add_argument("--engine", choices=["fpdf", "weasy"], default="weasy")
    pdf_p.add_argument("--title", help="Title for cover page (fpdf only)")

    # PPTX
    pptx_p = sub.add_parser("pptx")
    pptx_p.add_argument("--md", required=True, help="Markdown source file")
    pptx_p.add_argument("--output", "-o", required=True, help="Output PPTX path")
    pptx_p.add_argument("--images-dir", help="Directory containing images")

    # Collect renders
    collect_p = sub.add_parser("collect-renders")
    collect_p.add_argument("--comfyui-output", default=os.path.expanduser("~/Documents/ComfyUI/output"))
    collect_p.add_argument("--dest", required=True, help="Destination directory")
    collect_p.add_argument("--prefix", help="Filter files by prefix")

    # Insert images
    insert_p = sub.add_parser("insert-images")
    insert_p.add_argument("--md", required=True, help="Markdown file to update")
    insert_p.add_argument("--images-dir", required=True, help="Chain images directory")

    args = parser.parse_args()

    if args.command == "pdf":
        img_dir = args.images_dir or os.path.dirname(args.md)
        if args.engine == "weasy":
            md_to_pdf_weasy(args.md, args.output, img_dir)
        else:
            md_to_pdf_fpdf(args.md, args.output, img_dir, args.title)
    elif args.command == "pptx":
        img_dir = args.images_dir or os.path.dirname(args.md)
        md_to_pptx(args.md, args.output, img_dir)
    elif args.command == "collect-renders":
        collect_comfyui_renders(args.comfyui_output, args.dest, args.prefix)
    elif args.command == "insert-images":
        insert_images_into_md(args.md, args.images_dir)
    else:
        parser.print_help()
