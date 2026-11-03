import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const outputDir = path.join(root, 'output', 'launch');
const output = path.join(outputDir, 'hii-first-win-demo.mp4');

await mkdir(outputDir, { recursive: true });

const cards = [
  {
    file: '01-intent.svg',
    eyebrow: 'HII / ONE REAL JOB',
    lead: 'I gave HII one',
    accent: 'real job.',
    foot: 'No architecture lesson. Start with an outcome.'
  },
  {
    file: '02-boundary.svg',
    eyebrow: 'VISIBLE BOUNDARY',
    lead: 'Choose what it',
    accent: 'may use.',
    foot: 'The source and the permission stay visible.'
  },
  {
    file: '03-proof.svg',
    eyebrow: 'FINISHED MEANS INSPECTABLE',
    lead: 'Open the work.',
    accent: 'Open the proof.',
    foot: 'Files, checks, history, and the next move stay together.'
  },
  {
    file: '04-cta.svg',
    eyebrow: 'HII / MAC BETA',
    lead: 'One useful win.',
    accent: 'Then do it again.',
    foot: 'humaninformationinterface.com/learn'
  }
];

function escapeXml(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function cardSvg(card, index) {
  const background = index === 3 ? '#baff34' : '#f8f8f5';
  const accent = index === 3 ? '#151515' : '#176bff';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="${background}"/>
  <defs>
    <pattern id="dots" width="42" height="42" patternUnits="userSpaceOnUse">
      <circle cx="2" cy="2" r="1.3" fill="#151515" opacity=".10"/>
    </pattern>
  </defs>
  <rect width="1920" height="1080" fill="url(#dots)"/>
  <circle cx="120" cy="126" r="8" fill="${accent}"/>
  <text x="146" y="134" fill="#151515" font-family="SFMono-Regular, Menlo, monospace" font-size="25" font-weight="700" letter-spacing="4">${escapeXml(card.eyebrow)}</text>
  <text x="112" y="455" fill="#151515" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="162" font-weight="700" letter-spacing="-10">${escapeXml(card.lead)}</text>
  <text x="112" y="632" fill="${accent}" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="162" font-weight="700" letter-spacing="-10">${escapeXml(card.accent)}</text>
  <line x1="112" y1="805" x2="1808" y2="805" stroke="#151515" opacity=".18"/>
  <text x="112" y="875" fill="#151515" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="41" font-weight="500">${escapeXml(card.foot)}</text>
  <text x="1808" y="1000" text-anchor="end" fill="#151515" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="48" font-weight="700">hii</text>
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
  ['3', path.join(outputDir, cards[0].file.replace(/\.svg$/, '.png'))],
  ['5', path.join(root, 'public', 'marketing', 'hii-command-palette-live.png')],
  ['2', path.join(outputDir, cards[1].file.replace(/\.svg$/, '.png'))],
  ['6', path.join(root, 'public', 'marketing', 'hii-workspace-live.png')],
  ['2', path.join(outputDir, cards[2].file.replace(/\.svg$/, '.png'))],
  ['6', path.join(root, 'output', 'playwright', 'hii-knowledge', 'e2e-workspace.png')],
  ['3', path.join(outputDir, cards[3].file.replace(/\.svg$/, '.png'))]
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

const probe = spawnSync(
  'ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration,size', '-show_entries', 'stream=width,height,codec_name', '-of', 'json', output],
  { encoding: 'utf8' }
);
if (probe.status !== 0) {
  process.stderr.write(probe.stderr);
  process.exit(probe.status ?? 1);
}

process.stdout.write(`${output}\n${probe.stdout}`);
