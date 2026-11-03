import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputDir = path.join(root, 'output', 'launch', 'architecture');
const output = path.join(root, 'output', 'launch', 'hii-architecture-first-win-demo.mp4');
const publicOutput = path.join(root, 'public', 'marketing', 'hii-architecture-first-win-demo.mp4');

await mkdir(outputDir, { recursive: true });

const cards = [
  {
    file: '01-job.svg',
    eyebrow: 'HII / ARCHITECTURE COHORT',
    lead: 'One real job.',
    accent: 'One bounded set.',
    foot: 'Start with the decision or deliverable—not the platform.'
  },
  {
    file: '02-context.svg',
    eyebrow: 'ISSUE / 01 — APPROVED CONTEXT',
    lead: 'Choose the brief,',
    accent: 'reports, notes + model.',
    foot: 'The source and authority stay visible.'
  },
  {
    file: '03-proof.svg',
    eyebrow: 'ISSUE / 02 — REVIEWABLE RESULT',
    lead: 'Keep the artifact.',
    accent: 'Keep the proof.',
    foot: 'Changes, checks, provenance, and the next decision stay together.'
  },
  {
    file: '04-cohort.svg',
    eyebrow: 'FIVE FOUNDER-LED SESSIONS',
    lead: 'Bring the job',
    accent: 'you need done.',
    foot: 'humaninformationinterface.com/architecture'
  }
];

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function cardSvg(card, index) {
  const finalCard = index === cards.length - 1;
  const background = finalCard ? '#e43f2b' : '#f1f0e8';
  const ink = finalCard ? '#ffffff' : '#111317';
  const accent = finalCard ? '#ffffff' : '#0e4c92';
  const grid = finalCard ? '#ffffff' : '#0e4c92';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="${background}"/>
  <defs>
    <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
      <path d="M48 0H0V48" fill="none" stroke="${grid}" stroke-width="1" opacity=".12"/>
    </pattern>
  </defs>
  <rect width="1920" height="1080" fill="url(#grid)"/>
  <line x1="112" y1="126" x2="156" y2="126" stroke="${finalCard ? '#ffffff' : '#e43f2b'}" stroke-width="6"/>
  <text x="178" y="136" fill="${ink}" font-family="SFMono-Regular, Menlo, monospace" font-size="25" font-weight="700" letter-spacing="4">${escapeXml(card.eyebrow)}</text>
  <text x="108" y="455" fill="${ink}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="154" font-weight="700" letter-spacing="-10">${escapeXml(card.lead)}</text>
  <text x="108" y="628" fill="${accent}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="154" font-weight="700" letter-spacing="-10">${escapeXml(card.accent)}</text>
  <line x1="108" y1="804" x2="1812" y2="804" stroke="${ink}" opacity=".28"/>
  <text x="108" y="875" fill="${ink}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="39" font-weight="500">${escapeXml(card.foot)}</text>
  <g transform="translate(1650 82) rotate(2)">
    <rect width="164" height="112" fill="none" stroke="${finalCard ? '#ffffff' : '#e43f2b'}" stroke-width="3"/>
    <line x1="65" y1="0" x2="65" y2="70" stroke="${finalCard ? '#ffffff' : '#e43f2b'}"/>
    <line x1="0" y1="70" x2="164" y2="70" stroke="${finalCard ? '#ffffff' : '#e43f2b'}"/>
    <text x="18" y="43" fill="${finalCard ? '#ffffff' : '#e43f2b'}" font-family="Menlo, monospace" font-size="15">REV</text>
    <text x="88" y="49" fill="${finalCard ? '#ffffff' : '#e43f2b'}" font-family="Menlo, monospace" font-size="36" font-weight="700">01</text>
    <text x="14" y="91" fill="${finalCard ? '#ffffff' : '#e43f2b'}" font-family="Menlo, monospace" font-size="11">FOUNDER ISSUE</text>
  </g>
  <text x="1812" y="1000" text-anchor="end" fill="${ink}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="48" font-weight="700">hii</text>
</svg>`;
}

for (const [index, card] of cards.entries()) {
  const svg = path.join(outputDir, card.file);
  const png = svg.replace(/\.svg$/, '.png');
  await writeFile(svg, cardSvg(card, index), 'utf8');
  const render = spawnSync('sips', ['-s', 'format', 'png', svg, '--out', png], {
    encoding: 'utf8'
  });
  if (render.status !== 0) {
    process.stderr.write(render.stderr);
    process.exit(render.status ?? 1);
  }
}

const inputs = [
  ['3', path.join(outputDir, '01-job.png')],
  ['4', path.join(root, 'public', 'marketing', 'hii-architecture-hero.png')],
  ['2', path.join(outputDir, '02-context.png')],
  ['6', path.join(root, 'public', 'marketing', 'hii-workspace-live.png')],
  ['2', path.join(outputDir, '03-proof.png')],
  ['5', path.join(root, 'output', 'playwright', 'hii-knowledge', 'e2e-workspace.png')],
  ['3', path.join(outputDir, '04-cohort.png')]
];

const args = ['-y', '-hide_banner', '-loglevel', 'warning'];
for (const [duration, input] of inputs) {
  args.push('-loop', '1', '-framerate', '30', '-t', duration, '-i', input);
}

const filters = inputs.map(([, input], index) => {
  const isCard = input.startsWith(outputDir);
  if (isCard) {
    return `[${index}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${index}]`;
  }
  return `[${index}:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,zoompan=z='min(zoom+0.00022,1.035)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps=30,setsar=1[v${index}]`;
});

filters.push(`${inputs.map((_, index) => `[v${index}]`).join('')}concat=n=${inputs.length}:v=1:a=0[outv]`);

args.push(
  '-filter_complex',
  filters.join(';'),
  '-map',
  '[outv]',
  '-c:v',
  'libx264',
  '-preset',
  'medium',
  '-crf',
  '18',
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
  output
);

const ffmpeg = spawnSync('ffmpeg', args, { cwd: root, stdio: 'inherit' });
if (ffmpeg.status !== 0) process.exit(ffmpeg.status ?? 1);

await copyFile(output, publicOutput);

const probe = spawnSync(
  'ffprobe',
  [
    '-v',
    'error',
    '-show_entries',
    'format=duration,size',
    '-show_entries',
    'stream=width,height,codec_name',
    '-of',
    'json',
    publicOutput
  ],
  { encoding: 'utf8' }
);
if (probe.status !== 0) {
  process.stderr.write(probe.stderr);
  process.exit(probe.status ?? 1);
}

process.stdout.write(`${publicOutput}\n${probe.stdout}`);
