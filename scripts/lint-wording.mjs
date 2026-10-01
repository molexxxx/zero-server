#!/usr/bin/env node
// Checks prose files for the wording this repository refuses: em and en
// dashes, horizontal rules in Markdown, planning vocabulary, and British
// spellings. A third-party name that happens to contain such a word is listed
// in ALLOWED, and an all-caps identifier is never a spelling finding.
//
//   node scripts/lint-wording.mjs <file>...
//
// Exits 1 and prints one line per finding when any file fails.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
const PLANNING = /\b(phases?|waves?|sprints?|milestones?)\b/i;
const STEMS = [
  'colo', 'behavio', 'licenc', 'catalogu', 'metr', 'gr', 'artefact', 'programm',
  'defenc', 'travell', 'labell', 'modell', 'cancell', 'judgement', 'acknowledgement',
  'whilst', 'centr', 'favo', 'hono', 'initialis', 'optimis', 'organis', 'recognis',
  'normalis', 'serialis', 'analys', 'authoris', 'customis', 'minimis', 'maximis',
  'utilis', 'standardis', 'synchronis', 'tokenis', 'finalis', 'visualis', 'summaris',
  'prioritis', 'categoris', 'realis', 'specialis',
];
const ENDINGS = {
  colo: 'ur', behavio: 'ur', licenc: 'e', catalogu: 'e', metr: 'e', gr: 'ey', artefact: '',
  programm: 'e', defenc: 'e', travell: '(ing|ed|er)', labell: '(ing|ed)', modell: '(ing|ed)',
  cancell: '(ing|ed)', judgement: '', acknowledgement: '', whilst: '', centr: 'e', favo: 'ur',
  hono: 'ur', analys: '(e|ed|es|ing)', realis: '(e|ed|es|ing)',
};
const BRITISH = new RegExp(
  `\\b(${STEMS.map((stem) => stem + (ENDINGS[stem] ?? '(e|ed|es|ing|ation)')).join('|')})\\w*\\b`,
  'i',
);
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

// Names from other projects that contain a refused word, and the HTML attribute
// whose spelling WAI-ARIA fixes.
const ALLOWED = ['Command Phase', 'Connection Phase', 'aria-labelledby'];

let failures = 0;
for (const file of process.argv.slice(2))
{
  if (basename(file) === 'lint-wording.mjs') continue;
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const markdown = file.endsWith('.md');
  lines.forEach((raw, index) =>
  {
    const line = ALLOWED.reduce((text, name) => text.replaceAll(name, ''), raw);
    const report = (what) =>
    {
      failures += 1;
      console.log(`${file}:${index + 1}: ${what}`);
    };
    if (DASHES.test(line)) report('em or en dash');
    if (markdown && RULE.test(line)) report('horizontal rule');
    const planning = line.match(PLANNING);
    if (planning) report(`planning vocabulary: ${planning[0]}`);
    const british = line.match(BRITISH);
    if (british && british[0] !== british[0].toUpperCase()) report(`British spelling: ${british[0]}`);
  });
}
if (failures > 0)
{
  console.log(`${failures} finding(s)`);
  process.exit(1);
}
console.log('wording: clean');
