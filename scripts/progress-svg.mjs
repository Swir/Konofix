import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATH = 'ROADMAP.md';
const PROJECT = 'Konofix Chat';
const MILESTONE_PREFIX = '## 0.4.3 — Real Internet Test';
const NEXT_MILESTONE_PREFIX = '## 0.5.0';
const OUTPUTS = {
  card: 'assets/readme/progress-card.svg',
  mini: 'assets/readme/progress-mini.svg',
  template: 'assets/readme/progress-template.svg',
};

const COLORS = {
  base: '#02050A',
  surface: '#07111C',
  blue: '#0088FF',
  cyan: '#62E5FF',
  text: '#F4FAFF',
  muted: '#8DA8B8',
};

const LEGACY_TEXT_PROGRESS_METER = /(?:^|\n)\s*`?\s*(?:[█▓▒░■□▰▱]{5,}|\[[#=\-]{5,}\])(?:\s+\d+(?:\.\d+)?%)?\s*`?\s*(?=\n|$)/u;

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function computeProgress(completed, total) {
  if (!Number.isInteger(completed) || !Number.isInteger(total) || completed < 0 || total < 0 || completed > total) {
    throw new Error(`Invalid progress counter: completed=${completed}, total=${total}.`);
  }
  if (total === 0) {
    return { completed, total, fraction: null, percentage: null, percentText: 'N/A', status: 'PLANNING' };
  }
  const fraction = completed / total;
  const percentage = fraction * 100;
  return {
    completed,
    total,
    fraction,
    percentage,
    percentText: `${percentage.toFixed(1)}%`,
    status: completed === total ? 'COMPLETE' : completed === 0 ? 'PLANNING' : 'IN PROGRESS',
  };
}

export function parseMilestone(roadmapText) {
  const start = roadmapText.indexOf(MILESTONE_PREFIX);
  if (start < 0) throw new Error(`Could not locate '${MILESTONE_PREFIX}' in ${SOURCE_PATH}.`);
  const end = roadmapText.indexOf(`\n${NEXT_MILESTONE_PREFIX}`, start);
  const section = roadmapText.slice(start, end < 0 ? undefined : end);
  const completed = (section.match(/^- \[[xX]\] /gm) || []).length;
  const open = (section.match(/^- \[ \] /gm) || []).length;
  const total = completed + open;
  const heading = section.split(/\r?\n/, 1)[0]
    .replace(/^##\s+/, '')
    .replace(/\s+🚧\s*$/, '')
    .trim();
  return {
    ...computeProgress(completed, total),
    project: PROJECT,
    scope: heading,
    source: SOURCE_PATH,
  };
}

function wrapWords(text, maxChars) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines = [];
  let line = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${line} ${word}`;
    if (candidate.length <= maxChars) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  lines.push(line);
  return lines;
}

function fillWidth(progress, trackWidth) {
  if (progress.fraction === null) return 0;
  const width = trackWidth * progress.fraction;
  if (!Number.isFinite(width) || width < 0 || width > trackWidth) {
    throw new Error(`Computed fill width ${width} is outside 0..${trackWidth}.`);
  }
  return width;
}

function formatWidth(value) {
  return Number(value.toFixed(3)).toString();
}

function defs(clipId, trackX, trackY, trackWidth, trackHeight) {
  return `<defs>
    <linearGradient id="progressGradient" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${COLORS.blue}"/><stop offset="1" stop-color="${COLORS.cyan}"/></linearGradient>
    <linearGradient id="surfaceGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLORS.base}"/><stop offset="1" stop-color="${COLORS.surface}"/></linearGradient>
    <pattern id="grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M 28 0 L 0 0 0 28" fill="none" stroke="${COLORS.cyan}" stroke-opacity="0.035" stroke-width="1"/></pattern>
    <filter id="glow" x="-20%" y="-80%" width="140%" height="260%"><feGaussianBlur stdDeviation="4" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <clipPath id="${clipId}"><rect x="${trackX}" y="${trackY}" width="${trackWidth}" height="${trackHeight}" rx="${trackHeight / 2}"/></clipPath>
  </defs>`;
}

function progressFill(progress, { x, y, width, height, clipId }) {
  const filled = fillWidth(progress, width);
  if (filled <= 0) return '';
  return `<rect data-role="progress-fill" x="${x}" y="${y}" width="${formatWidth(filled)}" height="${height}" fill="url(#progressGradient)" clip-path="url(#${clipId})" filter="url(#glow)"/>`;
}

export function renderCard(progress) {
  const scopeLines = wrapWords(progress.scope, 63);
  const extraLines = Math.max(0, scopeLines.length - 1);
  const height = 180 + extraLines * 26;
  const track = { x: 50, y: 108 + extraLines * 26, width: 1100, height: 18, clipId: 'cardTrack' };
  const counter = progress.total === 0 ? 'VERIFIED / TOTAL: N/A' : `${progress.completed} / ${progress.total} VERIFIED TASKS`;
  const description = progress.total === 0
    ? `${progress.project} ${progress.scope}: progress is not verifiable because the scope has no denominator.`
    : `${progress.project} ${progress.scope}: ${progress.completed} of ${progress.total} verified tasks, ${progress.percentText}, ${progress.status}. Release readiness is a separate gate.`;
  const source = escapeXml(progress.source ?? SOURCE_PATH);
  const fill = progressFill(progress, track);
  const scopeText = scopeLines.map((line, index) => `<text x="50" y="${72 + index * 26}" fill="${COLORS.text}" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="600">${escapeXml(line)}</text>`).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${height}" viewBox="0 0 1200 ${height}" role="img" aria-labelledby="progressTitle progressDesc" data-source="${source}" data-completed="${progress.completed}" data-total="${progress.total}" data-progress-percent="${escapeXml(progress.percentText)}" data-fill-width="${formatWidth(fillWidth(progress, track.width))}">
  <title id="progressTitle">${escapeXml(progress.project)} — ${escapeXml(progress.scope)} progress</title>
  <desc id="progressDesc">${escapeXml(description)}</desc>
  ${defs(track.clipId, track.x, track.y, track.width, track.height)}
  <rect width="1200" height="${height}" rx="24" fill="url(#surfaceGradient)"/>
  <rect x="1" y="1" width="1198" height="${height - 2}" rx="23" fill="none" stroke="${COLORS.cyan}" stroke-opacity="0.28" stroke-width="2"/>
  <rect width="1200" height="${height}" rx="24" fill="url(#grid)"/>
  <text x="50" y="35" fill="${COLORS.cyan}" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="2">SWIR PROGRESS • ${escapeXml(progress.project.toUpperCase())}</text>
  <text x="1150" y="35" text-anchor="end" fill="${COLORS.cyan}" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="1.2">${escapeXml(progress.status)}</text>
  ${scopeText}
  <rect x="${track.x}" y="${track.y}" width="${track.width}" height="${track.height}" rx="${track.height / 2}" fill="#0B1825" stroke="${COLORS.cyan}" stroke-opacity="0.22"/>
  ${fill}
  <text x="50" y="${track.y + 50}" fill="${COLORS.muted}" font-family="Segoe UI, Arial, sans-serif" font-size="14">${escapeXml(counter)}</text>
  <text x="600" y="${track.y + 50}" text-anchor="middle" fill="${COLORS.muted}" font-family="Segoe UI, Arial, sans-serif" font-size="13">RELEASE READINESS IS A SEPARATE GATE</text>
  <text x="1150" y="${track.y + 50}" text-anchor="end" fill="${COLORS.text}" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700">${escapeXml(progress.percentText)}</text>
</svg>\n`;
}

export function renderMini(progress) {
  const scopeLines = wrapWords(progress.scope, 46);
  const extraLines = Math.max(0, scopeLines.length - 1);
  const height = 72 + extraLines * 24;
  const track = { x: 170, y: 38 + extraLines * 24, width: 700, height: 12, clipId: 'miniTrack' };
  const fill = progressFill(progress, track);
  const count = progress.total === 0 ? 'N/A' : `${progress.completed}/${progress.total}`;
  const description = progress.total === 0
    ? `${progress.project} ${progress.scope}: N/A progress.`
    : `${progress.project} ${progress.scope}: ${progress.completed} of ${progress.total}, ${progress.percentText}, ${progress.status}.`;
  const scopeText = scopeLines.map((line, index) => `<text x="170" y="${20 + index * 22}" fill="${COLORS.text}" font-family="Segoe UI, Arial, sans-serif" font-size="14" font-weight="600">${escapeXml(line)}</text>`).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}" role="img" aria-labelledby="miniTitle miniDesc" data-source="${escapeXml(progress.source ?? SOURCE_PATH)}" data-completed="${progress.completed}" data-total="${progress.total}" data-progress-percent="${escapeXml(progress.percentText)}" data-fill-width="${formatWidth(fillWidth(progress, track.width))}">
  <title id="miniTitle">${escapeXml(progress.project)} — ${escapeXml(progress.scope)} compact progress</title>
  <desc id="miniDesc">${escapeXml(description)}</desc>
  ${defs(track.clipId, track.x, track.y, track.width, track.height)}
  <rect width="900" height="${height}" rx="16" fill="url(#surfaceGradient)"/>
  <rect x="1" y="1" width="898" height="${height - 2}" rx="15" fill="none" stroke="${COLORS.cyan}" stroke-opacity="0.26" stroke-width="2"/>
  <text x="18" y="24" fill="${COLORS.cyan}" font-family="Segoe UI, Arial, sans-serif" font-size="12" font-weight="700" letter-spacing="1.5">KONOFIX</text>
  <text x="18" y="49" fill="${COLORS.muted}" font-family="Segoe UI, Arial, sans-serif" font-size="13">${escapeXml(count)} VERIFIED</text>
  ${scopeText}
  <rect x="${track.x}" y="${track.y}" width="${track.width}" height="${track.height}" rx="${track.height / 2}" fill="#0B1825" stroke="${COLORS.cyan}" stroke-opacity="0.2"/>
  ${fill}
  <text x="882" y="24" text-anchor="end" fill="${COLORS.text}" font-family="Segoe UI, Arial, sans-serif" font-size="17" font-weight="700">${escapeXml(progress.percentText)}</text>
</svg>\n`;
}

export function renderTemplate() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="180" viewBox="0 0 1200 180" role="img" aria-labelledby="templateTitle templateDesc" data-template="true" data-progress-percent="N/A">
  <title id="templateTitle">SWIR Progress SVG PRO — reusable template</title>
  <desc id="templateDesc">Template only. This file contains no project progress data and must not be embedded as live progress.</desc>
  ${defs('templateTrack', 50, 108, 1100, 18)}
  <rect width="1200" height="180" rx="24" fill="url(#surfaceGradient)"/>
  <rect x="1" y="1" width="1198" height="178" rx="23" fill="none" stroke="${COLORS.cyan}" stroke-opacity="0.28" stroke-width="2"/>
  <rect width="1200" height="180" rx="24" fill="url(#grid)"/>
  <text x="50" y="35" fill="${COLORS.cyan}" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="2">SWIR PROGRESS • TEMPLATE</text>
  <text x="1150" y="35" text-anchor="end" fill="${COLORS.muted}" font-family="Segoe UI, Arial, sans-serif" font-size="13" font-weight="700">TEMPLATE / NOT PROJECT DATA</text>
  <text x="50" y="72" fill="${COLORS.text}" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="600">PROJECT NAME — MEASURED SCOPE</text>
  <rect x="50" y="108" width="1100" height="18" rx="9" fill="#0B1825" stroke="${COLORS.cyan}" stroke-opacity="0.22"/>
  <text x="50" y="158" fill="${COLORS.muted}" font-family="Segoe UI, Arial, sans-serif" font-size="14">VERIFIED / TOTAL: N/A</text>
  <text x="1150" y="158" text-anchor="end" fill="${COLORS.text}" font-family="Segoe UI, Arial, sans-serif" font-size="22" font-weight="700">N/A</text>
</svg>\n`;
}

export function validateSvg(svg, label) {
  if (!/^<svg\b/.test(svg.trim())) throw new Error(`${label}: root element is not <svg>.`);
  if (!/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/.test(svg)) throw new Error(`${label}: SVG namespace is missing.`);
  const viewBox = svg.match(/\bviewBox="([^"]+)"/)?.[1]?.trim().split(/\s+/).map(Number);
  if (!viewBox || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value)) || viewBox[2] <= 0 || viewBox[3] <= 0) {
    throw new Error(`${label}: viewBox must contain four finite positive-size values.`);
  }
  if (!/<title\b[^>]*>/.test(svg) || !/<desc\b[^>]*>/.test(svg)) throw new Error(`${label}: accessible title/description are required.`);
  if (/<script\b|<foreignObject\b|\b(?:href|xlink:href)="(?:https?:|\/\/)/i.test(svg)) throw new Error(`${label}: scripts, foreignObject, and external resources are forbidden.`);
  if (/NaN|Infinity|width="XXX"|height="XXX"/.test(svg)) throw new Error(`${label}: non-finite or placeholder geometry detected.`);
  if ((svg.match(/<svg\b/g) || []).length !== 1 || (svg.match(/<\/svg>/g) || []).length !== 1) throw new Error(`${label}: SVG must contain exactly one root element.`);
}

function progressAlt(progress, compact) {
  const scopeLabel = progress.scope.replace(/^\d+(?:\.\d+){2}\s+—\s+/, '');
  const kind = compact ? 'compact progress' : 'progress';
  const measurement = progress.total === 0
    ? 'N/A'
    : `${progress.completed} of ${progress.total} verified tasks, ${progress.percentText}, ${progress.status.toLowerCase()}`;
  const releaseGate = compact ? '' : '; release readiness is a separate gate';
  return `${progress.project} ${scopeLabel} ${kind} — ${measurement}${releaseGate}`;
}

export function validateEmbeddings(readmeText, roadmapText, progress) {
  const readmePath = 'src="assets/readme/progress-card.svg"';
  const roadmapPath = 'src="assets/readme/progress-mini.svg"';
  if (!readmeText.includes(readmePath)) throw new Error('README.md must embed assets/readme/progress-card.svg near project status.');
  if (!roadmapText.includes(roadmapPath)) throw new Error('ROADMAP.md must embed assets/readme/progress-mini.svg near its authoritative status dashboard.');
  if (LEGACY_TEXT_PROGRESS_METER.test(readmeText)) throw new Error('README.md contains a retired text/Unicode progress meter; keep the SVG plus numeric fallback only.');
  if (LEGACY_TEXT_PROGRESS_METER.test(roadmapText)) throw new Error('ROADMAP.md contains a retired text/Unicode progress meter; keep the SVG plus numeric fallback only.');

  const readmeAlt = `alt="${escapeXml(progressAlt(progress, false))}"`;
  const roadmapAlt = `alt="${escapeXml(progressAlt(progress, true))}"`;
  if (!readmeText.includes(readmeAlt)) throw new Error('README.md progress-card alt text is stale or inconsistent with authoritative progress.');
  if (!roadmapText.includes(roadmapAlt)) throw new Error('ROADMAP.md progress-mini alt text is stale or inconsistent with authoritative progress.');

  const fallback = progress.total === 0
    ? 'Verified checklist fraction: N/A.'
    : `Verified checklist fraction: ${progress.completed} of ${progress.total} tasks — ${progress.percentText}.`;
  if (!readmeText.includes(fallback)) throw new Error(`README.md textual progress fallback is stale; expected '${fallback}'.`);
  if (!roadmapText.includes(fallback)) throw new Error(`ROADMAP.md textual progress fallback is stale; expected '${fallback}'.`);
}

export function generateAssets(roadmapText) {
  const progress = parseMilestone(roadmapText);
  const assets = {
    [OUTPUTS.card]: renderCard(progress),
    [OUTPUTS.mini]: renderMini(progress),
    [OUTPUTS.template]: renderTemplate(),
  };
  for (const [file, svg] of Object.entries(assets)) validateSvg(svg, file);
  return { progress, assets };
}

function main() {
  const roadmap = fs.readFileSync(path.join(ROOT, SOURCE_PATH), 'utf8');
  const { progress, assets } = generateAssets(roadmap);
  const checkOnly = process.argv.includes('--check');
  let stale = false;
  for (const [relativePath, expected] of Object.entries(assets)) {
    const fullPath = path.join(ROOT, relativePath);
    if (checkOnly) {
      if (!fs.existsSync(fullPath) || fs.readFileSync(fullPath, 'utf8') !== expected) {
        console.error(`PROGRESS SVG ERROR: ${relativePath} is missing or stale. Run: node scripts/progress-svg.mjs`);
        stale = true;
      }
    } else {
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, expected, 'utf8');
      console.log(`Wrote ${relativePath}`);
    }
  }
  if (checkOnly) {
    try {
      validateEmbeddings(
        fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'),
        roadmap,
        progress,
      );
    } catch (error) {
      console.error(`PROGRESS SVG ERROR: ${error.message}`);
      stale = true;
    }
  }
  if (stale) process.exitCode = 1;
  else console.log(`Progress SVG: ${progress.completed}/${progress.total} (${progress.percentText}) ${progress.status}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();