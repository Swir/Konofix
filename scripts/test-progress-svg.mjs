import assert from 'node:assert/strict';
import {
  computeProgress,
  parseMilestone,
  renderCard,
  renderMini,
  renderTemplate,
  validateSvg,
  validateEmbeddings,
} from './progress-svg.mjs';

const fixture = (completed, open, heading = '## 0.4.4 — Real Internet Test 🚧') => `${heading}\n${'- [x] done\n'.repeat(completed)}${'- [ ] todo\n'.repeat(open)}\n## 0.5.0 — Next\n`;

{
  const progress = { ...computeProgress(1, 13), project: 'Fixture', scope: 'Partial scope', source: 'fixture.md' };
  assert.equal(progress.percentText, '7.7%');
  const svg = renderCard(progress);
  assert.match(svg, /data-fill-width="84\.615"/);
  validateSvg(svg, 'partial fixture');
}

{
  const progress = { ...computeProgress(0, 13), project: 'Fixture', scope: 'Zero scope', source: 'fixture.md' };
  const svg = renderCard(progress);
  assert.equal(progress.percentText, '0.0%');
  assert.doesNotMatch(svg, /data-role="progress-fill"/);
  assert.match(svg, /data-fill-width="0"/);
}

{
  const progress = { ...computeProgress(13, 13), project: 'Fixture', scope: 'Complete scope', source: 'fixture.md' };
  const svg = renderCard(progress);
  assert.equal(progress.percentText, '100.0%');
  assert.match(svg, /data-fill-width="1100"/);
  assert.match(svg, />COMPLETE</);
}

{
  const progress = { ...computeProgress(0, 0), project: 'Fixture', scope: 'Unknown scope', source: 'fixture.md' };
  const svg = renderCard(progress);
  assert.equal(progress.percentText, 'N/A');
  assert.doesNotMatch(svg, /data-role="progress-fill"/);
  assert.match(svg, />VERIFIED \/ TOTAL: N\/A</);
}

{
  const progress = {
    ...computeProgress(3, 5),
    project: 'A & B <fixture>',
    scope: 'An intentionally long measured scope name that must wrap instead of overlapping labels inside the SWIR progress presentation',
    source: 'fixture.md',
  };
  const card = renderCard(progress);
  const mini = renderMini(progress);
  assert.match(card, /height="232" viewBox="0 0 1200 232"/);
  assert.match(card, /A &amp; B &lt;fixture&gt;/);
  assert.match(mini, /height="(?:96|120|144)"/);
  validateSvg(card, 'long card');
  validateSvg(mini, 'long mini');
}

{
  const template = renderTemplate();
  assert.match(template, /TEMPLATE \/ NOT PROJECT DATA/);
  assert.match(template, />N\/A</);
  assert.doesNotMatch(template, /data-role="progress-fill"/);
  validateSvg(template, 'template');
}

{
  const parsed = parseMilestone(fixture(2, 1));
  assert.equal(parsed.completed, 2);
  assert.equal(parsed.total, 3);
  assert.equal(parsed.percentText, '66.7%');
}

{
  const parsed = parseMilestone('## 0.4.4 — Real Internet Test 🚧\nNo checklist yet.\n\n## 0.5.0 — Next\n');
  assert.equal(parsed.total, 0);
  assert.equal(parsed.percentText, 'N/A');
  assert.equal(parsed.status, 'PLANNING');
}

{
  const progress = { ...computeProgress(54, 59), project: 'Konofix Chat', scope: '0.4.3 — Real Internet Test', source: 'ROADMAP.md' };
  const fallback = '**Verified checklist fraction: 54 of 59 tasks — 91.5%.**';
  const cardAlt = 'alt="Konofix Chat Real Internet Test progress — 54 of 59 verified tasks, 91.5%, in progress; release readiness is a separate gate"';
  const miniAlt = 'alt="Konofix Chat Real Internet Test compact progress — 54 of 59 verified tasks, 91.5%, in progress"';
  const readme = `<img src="assets/readme/progress-card.svg" ${cardAlt} />\n${fallback}`;
  const roadmap = `<img src="assets/readme/progress-mini.svg" ${miniAlt} />\n${fallback}`;

  assert.doesNotThrow(() => validateEmbeddings(readme, roadmap, progress));
  assert.throws(() => validateEmbeddings(
    readme,
    `<img src="assets/readme/progress-mini.svg" ${miniAlt} />\n**Verified checklist fraction: 54 of 59 tasks — 90.0%.**`,
    progress,
  ), /textual progress fallback is stale/);
  assert.throws(() => validateEmbeddings(
    readme.replace('91.5%, in progress; release readiness', '90.0%, in progress; release readiness'),
    roadmap,
    progress,
  ), /progress-card alt text is stale/);
  assert.throws(() => validateEmbeddings(
    readme,
    roadmap.replace('54 of 59 verified tasks', '53 of 59 verified tasks'),
    progress,
  ), /progress-mini alt text is stale/);
  assert.throws(() => validateEmbeddings(
    `${readme}\n\`██████████░░ 83%\``,
    roadmap,
    progress,
  ), /retired text\/Unicode progress meter/);
  assert.throws(() => validateEmbeddings(
    readme,
    `${roadmap}\n\`[##########--] 83%\``,
    progress,
  ), /retired text\/Unicode progress meter/);
}

console.log('Progress SVG adversarial/unit tests: PASS');
