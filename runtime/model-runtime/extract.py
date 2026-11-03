#!/usr/bin/env python3
"""Bounded, dependency-free document text extraction."""
import json
import pathlib
import re
import shutil
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_TEXT = 200000
MAX_ENTRY = 8 * 1024 * 1024
MAX_TOTAL = 32 * 1024 * 1024
TEXT_EXTS = {'.txt','.md','.markdown','.csv','.tsv','.json','.jsonl','.xml','.html','.htm','.yaml','.yml','.toml','.ini','.cfg','.log','.py','.js','.mjs','.cjs','.ts','.tsx','.jsx','.css','.scss','.rs','.go','.java','.c','.h','.cpp','.hpp','.sh','.sql','.tex','.rst','.svg'}


def xml(data):
    # Reject declarations even in UTF-16 XML before parsing.
    probe = data.replace(b'\x00', b'').upper()
    if b'<!DOCTYPE' in probe or b'<!ENTITY' in probe:
        raise ValueError('XML document declarations and entities are not allowed')
    return ET.fromstring(data)


def local(tag):
    return tag.rsplit('}', 1)[-1]


def content(node, tag='t'):
    return ''.join(n.text or '' for n in node.iter() if local(n.tag) == tag)


def zip_xml(path, choose, warnings):
    with zipfile.ZipFile(path) as archive:
        entries = [i for i in archive.infolist() if choose(i.filename)]
        if len(entries) > 40:
            warnings.append('ZIP XML entries truncated to 40')
            entries = entries[:40]
        total = 0
        result = {}
        for entry in entries:
            if entry.file_size > MAX_ENTRY:
                raise ValueError('ZIP XML entry exceeds 8 MB')
            total += entry.file_size
            if total > MAX_TOTAL:
                raise ValueError('ZIP XML content exceeds 32 MB')
            if entry.file_size / max(entry.compress_size, 1) > 500:
                raise ValueError('ZIP entry compression ratio exceeds 500')
            with archive.open(entry) as stream:
                data = stream.read(MAX_ENTRY + 1)
            if len(data) > MAX_ENTRY:
                raise ValueError('ZIP XML entry exceeds 8 MB')
            result[entry.filename] = xml(data)
        return result


def command_text(args):
    import tempfile
    import time
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(args, stdout=output, stderr=errors)
        deadline = time.monotonic() + 30
        capped = False
        while process.poll() is None:
            if output.tell() > MAX_TEXT * 4:
                capped = True
                process.kill()
                break
            if time.monotonic() >= deadline:
                process.kill()
                process.wait()
                raise ValueError('Extraction command timed out after 30 seconds')
            time.sleep(0.01)
        process.wait()
        if process.returncode and not capped:
            errors.seek(0)
            raise ValueError('Extraction command failed: ' + errors.read(1000).decode('utf-8', 'replace'))
        output.seek(0)
        data = output.read(MAX_TEXT * 4 + 1)
        return data.decode('utf-8', 'replace'), capped or len(data) > MAX_TEXT * 4


def extract(path):
    path = pathlib.Path(path).resolve(strict=True)
    if not path.is_file():
        raise ValueError('Input must be a regular file')
    ext = path.suffix.lower()
    warnings = []
    if ext in TEXT_EXTS:
        with path.open('rb') as stream:
            data = stream.read(MAX_TEXT * 4 + 1)
        if b'\x00' in data:
            raise ValueError('Text input contains NUL bytes')
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError as error:
            # A bounded read may split the final UTF-8 character.
            if len(data) > MAX_TEXT * 4 and error.start >= len(data) - 4:
                text = data[:error.start].decode('utf-8')
            else:
                raise ValueError('Text input must be UTF-8') from error
        kind = 'text'
    elif ext == '.pdf':
        tool = shutil.which('pdftotext')
        if not tool:
            raise ValueError('PDF extraction requires pdftotext')
        text, capped = command_text([tool, '-layout', '-f', '1', '-l', '40', str(path), '-'])
        kind = 'pdf'
        warnings.append('PDF extraction limited to first 40 pages')
    elif ext == '.rtf':
        tool = shutil.which('textutil')
        if not tool:
            raise ValueError('RTF extraction requires textutil')
        text, capped = command_text([tool, '-convert', 'txt', '-stdout', str(path)])
        kind = 'rtf'
    elif ext == '.docx':
        docs = zip_xml(path, lambda n: n == 'word/document.xml', warnings)
        root = docs.get('word/document.xml')
        if root is None:
            raise ValueError('DOCX has no document.xml')
        text = '\n'.join(content(p) for p in root.iter() if local(p.tag) == 'p')
        kind = 'docx'
    elif ext == '.pptx':
        docs = zip_xml(path, lambda n: bool(re.fullmatch(r'ppt/slides/slide\d+\.xml', n)), warnings)
        text = '\n\n'.join('Slide ' + re.search(r'slide(\d+)', n).group(1) + '\n' + '\n'.join(content(p) for p in root.iter() if local(p.tag) == 'p') for n, root in sorted(docs.items(), key=lambda pair: int(re.search(r'slide(\d+)', pair[0]).group(1))))
        kind = 'pptx'
    elif ext == '.odt':
        docs = zip_xml(path, lambda n: n == 'content.xml', warnings)
        root = docs.get('content.xml')
        if root is None:
            raise ValueError('ODT has no content.xml')
        text = '\n'.join(''.join(p.itertext()) for p in root.iter() if local(p.tag) in {'p', 'h'})
        kind = 'odt'
    elif ext == '.xlsx':
        docs = zip_xml(path, lambda n: n in {'xl/sharedStrings.xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels'} or bool(re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n)), warnings)
        shared = [content(n) for n in docs.get('xl/sharedStrings.xml', []) if local(n.tag) == 'si']
        rels = {n.attrib.get('Id'): n.attrib.get('Target', '') for n in docs.get('xl/_rels/workbook.xml.rels', [])}
        names = {}
        workbook = docs.get('xl/workbook.xml')
        if workbook is not None:
            for n in workbook.iter():
                if local(n.tag) == 'sheet':
                    rid = next((v for k, v in n.attrib.items() if local(k) == 'id'), '')
                    target = rels.get(rid, '')
                    name = target.lstrip('/') if target.startswith('/') else 'xl/' + target
                    names[name] = n.attrib.get('name', name)
        chunks = []
        for name, root in docs.items():
            if not name.startswith('xl/worksheets/'):
                continue
            rows = [n for n in root.iter() if local(n.tag) == 'row']
            if len(rows) > 200:
                warnings.append('Sheet ' + names.get(name, name) + ' truncated to first 200 rows')
            chunks.append('Sheet: ' + names.get(name, name))
            for row in rows[:200]:
                cells = []
                for cell in row:
                    if local(cell.tag) != 'c':
                        continue
                    value = content(cell, 'v')
                    if cell.attrib.get('t') == 's':
                        try:
                            value = shared[int(value)]
                        except (ValueError, IndexError):
                            value = ''
                    elif cell.attrib.get('t') == 'inlineStr':
                        value = content(cell)
                    cells.append(cell.attrib.get('r', '') + ': ' + value)
                chunks.append('\t'.join(cells))
        text = '\n'.join(chunks)
        kind = 'xlsx'
    else:
        raise ValueError('Unsupported file type: ' + (ext or '(none)'))
    if len(text) > MAX_TEXT or (ext in {'.pdf', '.rtf'} and capped):
        text = text[:MAX_TEXT]
        warnings.append('Text truncated to 200000 characters')
    return {'text': text, 'kind': kind, 'warnings': warnings}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage: extract.py PATH')
        print(json.dumps(extract(sys.argv[1]), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
