/**
 * Rebuild the ops whiteboard + inventory tables from docs/ops-map.json.
 *
 * Why islands instead of a spreadsheet: you should read this at a glance
 * (community boards + feature chips). Snowflake IDs live in OPS_MAP.md.
 *
 * Why a generator: the picture and the ID table must not drift.
 *
 * Usage: node scripts/render-ops-map.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_PATH = join(ROOT, 'docs', 'ops-map.json');
const DRAWIO_PATH = join(ROOT, 'docs', 'ops-map.drawio');
const EXCALIDRAW_PATH = join(ROOT, 'docs', 'ops-map.excalidraw');
const MD_PATH = join(ROOT, 'docs', 'OPS_MAP.md');

/** @type {Record<string, { fill: string, stroke: string, label: string, excaliFill: string, excaliStroke: string }>} */
const STATUS = {
  live: {
    fill: '#D5E8D4',
    stroke: '#82B366',
    label: 'LIVE',
    excaliFill: '#b2f2bb',
    excaliStroke: '#2b8a3e',
  },
  beta: {
    fill: '#FFF2CC',
    stroke: '#D6B656',
    label: 'BETA',
    excaliFill: '#ffec99',
    excaliStroke: '#e67700',
  },
  staged: {
    fill: '#F5F5F5',
    stroke: '#666666',
    label: 'STAGED',
    excaliFill: '#e9ecef',
    excaliStroke: '#495057',
  },
  waiting: {
    fill: '#DAE8FC',
    stroke: '#6C8EBF',
    label: 'WAITING',
    excaliFill: '#a5d8ff',
    excaliStroke: '#1c7ed6',
  },
  off: {
    fill: '#F8CECC',
    stroke: '#B85450',
    label: 'OFF',
    excaliFill: '#ffc9c9',
    excaliStroke: '#c92a2a',
  },
  none: {
    fill: '#FFFFFF',
    stroke: '#B3B3B3',
    label: '—',
    excaliFill: '#ffffff',
    excaliStroke: '#868e96',
  },
};

const ISLAND_W = 320;
const LINE_H = 26;
const TITLE_BLOCK = 78;
const PAD = 16;

function statusTag(status) {
  if (status === 'live') return '';
  if (status === 'beta') return '  · beta';
  if (status === 'staged') return '  · staged';
  if (status === 'waiting') return '  · waiting';
  return '';
}

/** One box, text inside — the actual Excalidraw pattern. */
function islandBody(island) {
  const items = island.chips.length
    ? island.chips.map((c) => `- ${c.text}${statusTag(c.status)}`)
    : ['- nothing live yet'];
  return `${island.name}\n${island.subtitle}\n\n${items.join('\n')}`;
}

const HIDDEN_ON_BOARD = new Set(['identity', 'ops']);

/**
 * Features that are on everywhere by default — drawing them on every island
 * is noise. Golden Pocket is the exception (fib is the prize product).
 */
function omitDefaultOn(featureId, communityId) {
  return featureId === 'fib' && communityId !== 'golden';
}

function isOn(entry) {
  return entry && !['off', 'none'].includes(entry.status);
}

/** Stable sketch seed so re-renders don't jump. */
function seed(str) {
  let h = 2166136261;
  for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return Math.abs(h) >>> 0;
}

function chipsOf(community, data) {
  const row = data.cells[community.id] || {};
  const xfeed = row.xfeed;
  const xradar = row.xradar;
  const mergeX = isOn(xfeed) && isOn(xradar);
  const chips = [];
  for (const f of data.features) {
    if (HIDDEN_ON_BOARD.has(f.id)) continue;
    if (omitDefaultOn(f.id, community.id)) continue;
    if (f.id === 'xradar' && mergeX) continue;
    const entry = row[f.id];
    if (!isOn(entry)) continue;
    let text = entry.chip;
    if (!text) {
      const line = (entry.lines || []).find((l) => !/^\d{15,}$/.test(l)) || f.label;
      text = line;
    }
    if (f.id === 'xfeed' && mergeX && !entry.chip) text = 'X posts + follows';
    chips.push({ id: f.id, status: entry.status, text });
  }
  return chips;
}

function islandHeight(chipCount) {
  return TITLE_BLOCK + Math.max(chipCount, 1) * LINE_H + PAD + 8;
}

/**
 * Spatial layout: prod pair inside a dashed "one bot" frame,
 * everything else as separate islands. Absence of a chip = off.
 */
function buildScene(data) {
  const islands = data.communities.map((c) => {
    const chips = chipsOf(c, data);
    const island = {
      ...c,
      chips,
      w: ISLAND_W,
      h: islandHeight(chips.length),
      x: 0,
      y: 0,
    };
    island.body = islandBody(island);
    return island;
  });
  const prod = islands.filter((i) => i.sharedBot === 'prod');
  const rest = islands.filter((i) => i.sharedBot !== 'prod');

  const originX = 56;
  const originY = 148;
  const gap = 28;
  let px = originX + 36;
  let prodH = 0;
  for (const i of prod) {
    i.x = px;
    i.y = originY + 56;
    prodH = Math.max(prodH, i.h);
    px += i.w + gap;
  }
  for (const i of prod) i.h = prodH;

  const shared = {
    x: originX,
    y: originY,
    w: px - originX + 8,
    h: prodH + 56 + 28,
    label: 'ONE bot   ·   ONE volume   ·   perpetual-clarity',
  };

  const byId = Object.fromEntries(rest.map((i) => [i.id, i]));
  const newest = byId.newest;
  const genny = byId.genny;
  const collective = byId.collective;
  const blackjack = byId.blackjack;
  const golden = byId.golden;

  if (newest) {
    newest.x = shared.x + shared.w + 48;
    newest.y = originY;
  }
  if (genny) {
    genny.x = (newest ? newest.x + newest.w + gap : shared.x + shared.w + 48);
    genny.y = originY;
  }
  if (golden) {
    golden.x = originX;
    golden.y = shared.y + shared.h + 40;
    golden.w = 380;
  }
  if (collective) {
    collective.x = (golden ? golden.x + golden.w + 48 : originX);
    collective.y = golden ? golden.y : shared.y + shared.h + 40;
  }
  if (blackjack) {
    blackjack.x = (collective ? collective.x + collective.w + 48 : originX);
    blackjack.y = collective ? collective.y : (golden ? golden.y : shared.y + shared.h + 40);
  }

  return { islands, shared, updated: data.updated, warning: data.warning };
}

function htmlText(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function xmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function mx(id, html, style, x, y, w, h) {
  return (
    `        <mxCell id="${xmlAttr(id)}" value="${xmlAttr(html)}" style="${xmlAttr(style)}" vertex="1" parent="1">\n` +
    `          <mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/>\n` +
    `        </mxCell>`
  );
}

/** White fill, black stroke — default Excalidraw, not a coloured dashboard. */
const LINE =
  'rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#1A1A1A;strokeWidth=2;fontFamily=Helvetica;fontSize=14;align=left;verticalAlign=top;spacingLeft=14;spacingTop=8;spacingRight=12;arcSize=6;';

const BOX =
  'rounded=1;whiteSpace=wrap;html=1;fillColor=#FFFFFF;strokeColor=#1A1A1A;strokeWidth=2;fontFamily=Helvetica;fontSize=14;align=center;verticalAlign=middle;arcSize=6;';

const EDGE =
  'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=#1A1A1A;strokeWidth=2;endArrow=blockThin;endFill=1;fontFamily=Helvetica;fontSize=11;fontColor=#1A1A1A;labelBackgroundColor=#FFFFFF;';

function islandHtml(i) {
  const items = i.chips.length
    ? i.chips.map((c) => `- ${htmlText(c.text)}${htmlText(statusTag(c.status))}`).join('<br>')
    : '- nothing live yet';
  return `<b><font style="font-size:16px">${htmlText(i.name)}</font></b><br><font color="#666666">${htmlText(i.subtitle)}</font><br><br>${items}`;
}

function mxEdge(id, source, target, label = '', dashed = false) {
  const style = dashed ? EDGE + 'dashed=1;dashPattern=8 8;' : EDGE;
  const value = label ? ` value="${xmlAttr(label)}"` : '';
  return (
    `        <mxCell id="${xmlAttr(id)}" style="${style}" edge="1" parent="1" source="${xmlAttr(source)}" target="${xmlAttr(target)}"${value}>\n` +
    `          <mxGeometry relative="1" as="geometry"/>\n` +
    `        </mxCell>`
  );
}

function renderDrawio(scene) {
  const byId = Object.fromEntries(scene.islands.map((i) => [i.id, i]));
  const personal = byId.personal;
  const tp4aph = byId.tp4aph;
  const newest = byId.newest;
  const collective = byId.collective;
  const genny = byId.genny;
  const blackjack = byId.blackjack;
  const golden = byId.golden;

  const leafW = 250;
  const svcH = 56;
  const gitY = 118;
  const svcY = 220;
  const leafY = 340;

  personal.x = 40;
  personal.y = leafY;
  personal.w = leafW;
  tp4aph.x = 310;
  tp4aph.y = leafY;
  tp4aph.w = leafW;
  newest.x = 580;
  newest.y = leafY;
  newest.w = 210;
  newest.h = Math.max(newest.h, 88);
  collective.x = 820;
  collective.y = leafY;
  collective.w = leafW;
  genny.x = 1090;
  genny.y = leafY;
  genny.w = 210;
  genny.h = Math.max(genny.h, 88);
  if (blackjack) {
    blackjack.x = 1320;
    blackjack.y = leafY;
    blackjack.w = leafW;
  }
  golden.x = blackjack ? 1590 : 1320;
  golden.y = leafY;
  golden.w = 250;

  const cells = [];
  cells.push(
    mx(
      'title',
      `<font style="font-size:26px"><b>take profits</b></font><br><font color="#666666">${htmlText(scene.updated)} · IDs in OPS_MAP.md</font>`,
      'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=top;fontFamily=Helvetica;fontSize=14;whiteSpace=wrap',
      40,
      20,
      640,
      56,
    ),
  );
  cells.push(
    mx(
      'warn',
      htmlText(scene.warning),
      'text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=top;fontFamily=Helvetica;fontSize=12;fontColor=#666666;whiteSpace=wrap',
      40,
      78,
      1100,
      32,
    ),
  );

  cells.push(
    mx('git', '<b>main</b><br><font color="#666666">one repo · flags per service</font>', BOX, 680, gitY, 220, 52),
  );
  cells.push(
    mx('prod', '<b>prod bot</b><br><font color="#666666">perpetual-clarity</font>', BOX, 310, svcY, 240, svcH),
  );
  cells.push(
    mx('svc-collective', '<b>Collective bot</b><br><font color="#666666">TPB_Collective</font>', BOX, 835, svcY, 220, svcH),
  );
  cells.push(
    mx('svc-genny', '<b>Genny bot</b><br><font color="#666666">TPB_Genny_Run</font>', BOX, 1090, svcY, 200, svcH),
  );
  if (blackjack) {
    cells.push(
      mx('svc-blackjack', '<b>Blackjack bot</b><br><font color="#666666">TPB_Blackjack</font>', BOX, 1320, svcY, 220, svcH),
    );
  }
  cells.push(
    mx('svc-golden', '<b>GP bot</b><br><font color="#666666">telegram</font>', BOX, blackjack ? 1590 : 1320, svcY, 200, svcH),
  );

  for (const i of [personal, tp4aph, newest, collective, genny, blackjack, golden].filter(Boolean)) {
    cells.push(mx(`island-${i.id}`, islandHtml(i), LINE, i.x, i.y, i.w, i.h));
  }

  cells.push(mxEdge('e-git-prod', 'git', 'prod'));
  cells.push(mxEdge('e-git-coll', 'git', 'svc-collective'));
  cells.push(mxEdge('e-git-genny', 'git', 'svc-genny'));
  if (blackjack) cells.push(mxEdge('e-git-blackjack', 'git', 'svc-blackjack'));
  cells.push(mxEdge('e-git-golden', 'git', 'svc-golden'));
  cells.push(mxEdge('e-prod-personal', 'prod', 'island-personal', 'same token + volume'));
  cells.push(mxEdge('e-prod-tp', 'prod', 'island-tp4aph', 'same token + volume'));
  cells.push(mxEdge('e-prod-newest', 'prod', 'island-newest', 'staged X route', true));
  cells.push(mxEdge('e-coll', 'svc-collective', 'island-collective', 'own token'));
  cells.push(mxEdge('e-genny', 'svc-genny', 'island-genny', 'own token'));
  if (blackjack) cells.push(mxEdge('e-blackjack', 'svc-blackjack', 'island-blackjack', 'own token'));
  cells.push(mxEdge('e-golden', 'svc-golden', 'island-golden'));

  const runY = Math.max(personal.y + personal.h, tp4aph.y + tp4aph.h, golden.y + golden.h) + 56;
  const runH = 52;
  const runW = 170;
  const runGap = 36;
  let rx = 40;
  const run = [
    ['run-ca', 'CA / NFT url<br>pasted in chat'],
    ['run-track', 'autoTrack<br>first caller wins'],
    ['run-db', '/data<br>tracked.json'],
    ['run-poll', 'poller<br>~3 min'],
    ['run-card', 'card in that<br>OG channel'],
  ];
  cells.push(
    mx(
      'run-label',
      'volume bot — every instance',
      'text;html=1;strokeColor=none;fillColor=none;align=left;fontFamily=Helvetica;fontSize=12;fontColor=#666666',
      40,
      runY - 28,
      400,
      24,
    ),
  );
  run.forEach(([id, label], i) => {
    cells.push(mx(id, label, BOX, rx, runY, runW, runH));
    if (i > 0) cells.push(mxEdge(`e-run-${i}`, run[i - 1][0], id));
    rx += runW + runGap;
  });

  const pageW = 1620;
  const pageH = runY + runH + 48;

  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile host="app.diagrams.net" modified="${scene.updated}T00:00:00.000Z" agent="render-ops-map.mjs" version="22.1.0" type="device">
  <diagram id="ops-map" name="Ops map">
    <mxGraphModel dx="1400" dy="900" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="0" page="1" pageScale="1" pageWidth="${pageW}" pageHeight="${pageH}" math="0" shadow="0">
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
${cells.join('\n')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;
}

function nextIndex(n) {
  return 'a' + n.toString(36);
}

function baseEl(id, type, extra) {
  return {
    id,
    type,
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: nextIndex(baseEl._n++),
    roundness: type === 'text' ? null : { type: 3 },
    seed: seed(id),
    version: 1,
    versionNonce: seed(id + ':v'),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    ...extra,
  };
}
baseEl._n = 0;

function rect(id, x, y, w, h, extra = {}) {
  return baseEl(id, 'rectangle', { x, y, width: w, height: h, ...extra });
}

function text(id, x, y, w, h, value, extra = {}) {
  return baseEl(id, 'text', {
    x,
    y,
    width: w,
    height: h,
    text: value,
    originalText: value,
    fontSize: extra.fontSize || 20,
    fontFamily: 1,
    textAlign: extra.textAlign || 'left',
    verticalAlign: extra.verticalAlign || 'top',
    containerId: extra.containerId || null,
    lineHeight: 1.25,
    autoResize: extra.autoResize !== false,
    strokeColor: extra.strokeColor || '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    roughness: 0,
    roundness: null,
    angle: extra.angle || 0,
    groupIds: extra.groupIds || [],
  });
}

function renderExcalidraw(scene) {
  baseEl._n = 0;
  const elements = [];
  const { islands, shared } = scene;

  elements.push(text('title', 56, 28, 520, 44, 'what lives where', { fontSize: 36 }));
  elements.push(
    text(
      'meta',
      56,
      72,
      900,
      48,
      `Take Profits  ·  ${scene.updated}  ·  IDs in OPS_MAP.md\n${scene.warning}`,
      { fontSize: 14, strokeColor: '#868e96', autoResize: false },
    ),
  );

  elements.push(
    rect('shared', shared.x, shared.y, shared.w, shared.h, {
      backgroundColor: 'transparent',
      strokeColor: '#1e1e1e',
      strokeStyle: 'dashed',
      fillStyle: 'solid',
      roughness: 1,
    }),
  );
  elements.push(
    text('shared-t', shared.x + 12, shared.y + 8, shared.w - 24, 24, shared.label, {
      fontSize: 14,
      textAlign: 'center',
      autoResize: false,
    }),
  );

  for (const i of islands) {
    const gid = ['g-' + i.id];
    const box = rect(`island-${i.id}`, i.x, i.y, i.w, i.h, {
      backgroundColor: '#ffffff',
      strokeColor: '#1e1e1e',
      fillStyle: 'solid',
      roughness: 1,
      groupIds: gid,
    });
    elements.push(box);
    const lines = i.body.split('\n').length;
    elements.push(
      text(`island-${i.id}-t`, i.x + 16, i.y + 12, i.w - 32, lines * 26, i.body, {
        fontSize: 18,
        groupIds: gid,
        autoResize: false,
      }),
    );
  }

  return JSON.stringify(
    {
      type: 'excalidraw',
      version: 2,
      source: 'take-profits-ops-map',
      elements,
      appState: {
        gridSize: null,
        viewBackgroundColor: '#ffffff',
      },
      files: {},
    },
    null,
    2,
  );
}

function mermaidLabel(s) {
  return String(s).replace(/"/g, "'");
}

function mermaidNode(id, title, subtitle, chips) {
  const items = chips.length
    ? chips.map((c) => {
        const tag = statusTag(c.status);
        const already = tag && c.text.toLowerCase().includes(c.status);
        return `- ${c.text}${already ? '' : tag}`;
      }).join('<br/>')
    : '- nothing live yet';
  const body = subtitle ? `${title}<br/>${subtitle}<br/>${items}` : `${title}<br/>${items}`;
  return `  ${id}["${mermaidLabel(body)}"]`;
}

/**
 * GitHub/Cursor architecture view. architecture-beta is the new Mermaid
 * infra diagram (v11.1+). Flowcharts stay as a fallback for older preview.
 */
function renderMermaid(scene) {
  const architecture = [
    'architecture-beta',
    '  group repo(cloud)[git main]',
    '  group prod(cloud)[perpetual-clarity]',
    '  group coll(cloud)[TPB_Collective]',
    '  group gennyg(cloud)[TPB_Genny_Run]',
    '  group blackjack(cloud)[TPB_Blackjack]',
    '  group gp(cloud)[Golden Pocket TG]',
    '',
    '  service git(server)[main] in repo',
    '',
    '  service prodBot(server)[prod bot] in prod',
    '  service prodVol(database)[/data volume] in prod',
    '  service bitcernals(internet)[Bitcernals] in prod',
    '  service tp4aph(internet)[TP4APH] in prod',
    '  service newest(internet)[Newest staged] in prod',
    '',
    '  service collBot(server)[Collective bot] in coll',
    '  service collVol(database)[/data] in coll',
    '  service collDc(internet)[Collective Discord] in coll',
    '',
    '  service gennyBot(server)[Genny bot] in gennyg',
    '  service gennyVol(database)[/data] in gennyg',
    '  service gennyDc(internet)[Genny Discord] in gennyg',
    '',
    '  service bjBot(server)[Blackjack bot] in blackjack',
    '  service bjVol(database)[/data] in blackjack',
    '  service bjDc(internet)[Blackjack Discord] in blackjack',
    '',
    '  service gpBot(server)[GP bot] in gp',
    '  service gpVol(database)[/data] in gp',
    '  service gpTg(internet)[Golden Pocket] in gp',
    '',
    '  git{group}:B --> T:prodBot{group}',
    '  git{group}:B --> T:collBot{group}',
    '  git{group}:B --> T:gennyBot{group}',
    '  git{group}:B --> T:bjBot{group}',
    '  git{group}:B --> T:gpBot{group}',
    '',
    '  prodBot:R -- L:prodVol',
    '  prodBot:B --> T:bitcernals',
    '  prodBot:B --> T:tp4aph',
    '  prodBot:B --> T:newest',
    '',
    '  collBot:R -- L:collVol',
    '  collBot:B --> T:collDc',
    '',
    '  gennyBot:R -- L:gennyVol',
    '  gennyBot:B --> T:gennyDc',
    '',
    '  bjBot:R -- L:bjVol',
    '  bjBot:B --> T:bjDc',
    '',
    '  gpBot:R -- L:gpVol',
    '  gpBot:B --> T:gpTg',
  ].join('\n');

  const byId = Object.fromEntries(scene.islands.map((i) => [i.id, i]));
  const n = (id) => {
    const i = byId[id];
    return mermaidNode(id, i.name, i.subtitle, i.chips);
  };

  const topology = [
    'flowchart TB',
    '  git["main<br/>one repo · flags per service"]',
    '  prod["prod bot<br/>perpetual-clarity"]',
    '  collBot["Collective bot<br/>TPB_Collective"]',
    '  gennyBot["Genny bot<br/>TPB_Genny_Run"]',
    '  bjBot["Blackjack bot<br/>TPB_Blackjack"]',
    '  gpBot["Golden Pocket bot<br/>PLATFORM=telegram"]',
    n('personal'),
    n('tp4aph'),
    n('newest'),
    n('collective'),
    n('genny'),
    n('blackjack'),
    n('golden'),
    '  git --> prod',
    '  git --> collBot',
    '  git --> gennyBot',
    '  git --> bjBot',
    '  git --> gpBot',
    '  subgraph shared["same Discord token + /data volume"]',
    '    personal',
    '    tp4aph',
    '    newest',
    '  end',
    '  prod --> personal',
    '  prod --> tp4aph',
    '  prod -.-> newest',
    '  collBot --> collective',
    '  gennyBot --> genny',
    '  bjBot --> blackjack',
    '  gpBot --> golden',
  ].join('\n');

  const runtime = [
    'flowchart LR',
    '  ca["CA / NFT url<br/>pasted in chat"] --> track["autoTrack<br/>first caller wins"]',
    '  track --> db["/data<br/>tracked.json"]',
    '  db --> poll["poller<br/>~3 min"]',
    '  poll --> card["card in that<br/>OG channel"]',
  ].join('\n');

  return { architecture, topology, runtime };
}

function renderArchitectureMd(scene) {
  const { architecture, topology, runtime } = renderMermaid(scene);
  return `# Architecture

Generated from [\`ops-map.json\`](ops-map.json). Do not hand-edit — run \`node scripts/render-ops-map.mjs\`.

${scene.warning}

## New architecture (\`architecture-beta\`)

Cloud-style groups: one box per Railway project. Server = bot, database = volume, internet = Discord/TG. Needs Mermaid 11.1+ (GitHub has it; if Cursor preview is a blank box, use the flowchart below).

\`\`\`mermaid
${architecture}
\`\`\`

## Topology (flowchart)

Feature lists live here. Dashed line = staged.

\`\`\`mermaid
${topology}
\`\`\`

## Volume bot

Every instance runs this path. Alerts go to the channel that first tracked the CA.

\`\`\`mermaid
${runtime}
\`\`\`
`;
}
function mdStatus(status) {
  return `**${(STATUS[status] || STATUS.none).label}**`;
}

function renderInventoryMd(data) {
  const communities = data.communities;
  const features = data.features;
  const header = `| Feature | ${communities.map((c) => c.name).join(' | ')} |`;
  const sep = `|---|${communities.map(() => '---').join('|')}|`;
  const rows = features.map((f) => {
    const cells = communities.map((c) => {
      const entry = data.cells[c.id]?.[f.id] || { status: 'none', lines: [] };
      const body = (entry.lines || []).join('<br>');
      return `${mdStatus(entry.status)}<br>${body}`;
    });
    return `| ${f.label.replace(/\n/g, ' ')} | ${cells.join(' | ')} |`;
  });
  const colMeta = communities.map((c) => `| ${c.name} | ${c.platform} | ${c.headerNote} |`).join('\n');
  return `**Last updated:** ${data.updated}

${data.warning}

### Communities

| Community | Platform | Status |
|---|---|---|
${colMeta}

### Feature × community (IDs live here — not on the whiteboard)

${header}
${sep}
${rows.join('\n')}
`;
}

const START = '<!-- OPS_MAP_INVENTORY_START -->';
const END = '<!-- OPS_MAP_INVENTORY_END -->';
const MERMAID_START = '<!-- OPS_MAP_MERMAID_START -->';
const MERMAID_END = '<!-- OPS_MAP_MERMAID_END -->';
const ARCH_PATH = join(ROOT, 'docs', 'ARCHITECTURE.md');

function patchBetween(md, start, end, body) {
  const i = md.indexOf(start);
  const j = md.indexOf(end);
  if (i === -1 || j === -1 || j < i) {
    throw new Error('OPS_MAP.md is missing markers ' + start);
  }
  return md.slice(0, i + start.length) + '\n\n' + body + '\n' + md.slice(j);
}

function patchMarkdown(inventory, mermaidBlock) {
  let md = readFileSync(MD_PATH, 'utf8');
  md = patchBetween(md, MERMAID_START, MERMAID_END, mermaidBlock);
  md = patchBetween(md, START, END, inventory);
  return md;
}

const data = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
const scene = buildScene(data);
const { architecture, topology, runtime } = renderMermaid(scene);
const mermaidBlock =
  '### New architecture\n\n```mermaid\n' +
  architecture +
  '\n```\n\n### Topology\n\n```mermaid\n' +
  topology +
  '\n```\n\n### Volume bot\n\n```mermaid\n' +
  runtime +
  '\n```\n';
writeFileSync(DRAWIO_PATH, renderDrawio(scene), 'utf8');
writeFileSync(EXCALIDRAW_PATH, renderExcalidraw(scene), 'utf8');
writeFileSync(ARCH_PATH, renderArchitectureMd(scene), 'utf8');
writeFileSync(MD_PATH, patchMarkdown(renderInventoryMd(data), mermaidBlock), 'utf8');
console.log('[ops-map] wrote ' + DRAWIO_PATH);
console.log('[ops-map] wrote ' + EXCALIDRAW_PATH);
console.log('[ops-map] wrote ' + ARCH_PATH);
console.log('[ops-map] patched inventory + mermaid in ' + MD_PATH);
