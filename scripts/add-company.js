#!/usr/bin/env node
/**
 * Interactive setup script — adds a company to config/targets.json.
 *
 * Usage:
 *   npm run add-company
 *
 * Answers 5 questions, writes the new target, and tells you which parser
 * to expect issues with. No dependencies — uses Node's built-in readline.
 */
import { createInterface } from 'node:readline/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TARGETS_PATH = path.join(__dirname, '..', 'config', 'targets.json');

const PARSERS = {
  1: { key: 'generic',    label: 'Generic HTML (default — works for most career pages)' },
  2: { key: 'lever',      label: 'Lever (jobs.lever.co/...)' },
  3: { key: 'greenhouse', label: 'Greenhouse (boards.greenhouse.io/...)' },
  4: { key: 'workday',    label: 'Workday (*.myworkdayjobs.com — needs a base URL too)' },
};

const SECTORS = ['Luxury', 'Beauty', 'Retail', 'FMCG', 'Sports', 'E-commerce', 'Big Tech', 'Media'];

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => rl.question(q);

  console.log('\nAdd a company to the scraper (config/targets.json)\n');

  const company = (await ask('Company name (e.g. "Stripe"): ')).trim();
  if (!company) { console.error('Company name is required.'); process.exit(1); }

  console.log(`\nSectors: ${SECTORS.map((s, i) => `${i + 1}) ${s}`).join('   ')}`);
  const sectorIdx = (await ask('Pick a sector number (or type your own): ')).trim();
  const sector = SECTORS[parseInt(sectorIdx) - 1] || sectorIdx || 'Other';

  const url = (await ask('\nCareer page URL (paste the search results / jobs page URL): ')).trim();
  if (!url) { console.error('A URL is required.'); process.exit(1); }

  console.log('\nWhich parser matches this career page?');
  for (const [num, { label }] of Object.entries(PARSERS)) console.log(`  ${num}) ${label}`);
  console.log('  Tip: if unsure, check the URL — jobs.lever.co → Lever, boards.greenhouse.io → Greenhouse,');
  console.log('       *.myworkdayjobs.com → Workday, anything else → Generic (option 1) and see what the');
  console.log('       first scrape run finds. Generic works surprisingly often.');
  const parserIdx = (await ask('Parser number [1]: ')).trim() || '1';
  const parser = (PARSERS[parserIdx] || PARSERS[1]).key;

  const target = { company, sector, url, parser };

  if (parser === 'workday') {
    const baseUrl = (await ask('\nWorkday base URL for job links (e.g. https://acme.wd1.myworkdayjobs.com/en-US/External): ')).trim();
    if (baseUrl) target.baseUrl = baseUrl;
    console.log('Note: Workday targets fetch ALL open roles then filter by your rubric —');
    console.log('no keyword search is sent to the API. That is normal.');
  }

  rl.close();

  const raw = await readFile(TARGETS_PATH, 'utf-8');
  const data = JSON.parse(raw);

  if (data.targets.some(t => t.company.toLowerCase() === company.toLowerCase())) {
    console.error(`\n"${company}" is already in config/targets.json — not adding a duplicate.`);
    process.exit(1);
  }

  data.targets.push(target);
  await writeFile(TARGETS_PATH, JSON.stringify(data, null, 2) + '\n');

  console.log(`\nAdded ${company} to config/targets.json.`);
  console.log('Next steps:');
  console.log('  1. Redeploy (or it will pick up automatically if config/ is bundled with your Vercel project).');
  console.log('  2. Test it in isolation: GET /api/scrape?dry=1 and check the logs for this company.');
  console.log('  3. If the generic parser finds 0 roles but you know roles exist, the career page likely');
  console.log('     needs a specific parser (Lever/Greenhouse/Workday) — check its URL pattern and re-run');
  console.log('     `npm run add-company` to fix the entry, or edit config/targets.json directly.\n');
}

main().catch((err) => {
  console.error('add-company failed:', err.message);
  process.exit(1);
});
