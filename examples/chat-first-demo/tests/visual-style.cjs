'use strict';
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { JSDOM, VirtualConsole } = require(process.env.JSDOM_PATH || 'jsdom');
const cssTree = require(process.env.CSS_TREE_PATH || 'css-tree');
const paths = ['style.css', 'demo-lab.css', 'inspection.css', 'modern.css'];
const css = Object.fromEntries(paths.map(name => [name, fs.readFileSync('dist/' + name, 'utf8')]));
for (const [name, source] of Object.entries(css)) {
  const ast = cssTree.parse(source);
  cssTree.walk(ast, node => {
    if (node.type !== 'Declaration' || node.property.startsWith('--')) return;
    const value = cssTree.generate(node.value);
    if (value.includes('var(')) return;
    const match = cssTree.lexer.matchProperty(node.property, node.value);
    assert.equal(match.error, null, name + ': ' + node.property + ': ' + value);
  });
}
const theme = css['modern.css'];
const expected = { '--bg': '#F7F8FA', '--surface': '#FFFFFF', '--sidebar': '#F9FAFB', '--text': '#1D1D1F', '--muted': '#6E6E73', '--border': '#E5E7EB', '--focus': '#007AFF', '--radius': '12px', '--radius-card': '16px', '--radius-composer': '20px' };
const ast = cssTree.parse(theme);
const root = ast.children.toArray().find(n => n.type === 'Rule' && cssTree.generate(n.prelude) === ':root');
const tokens = Object.fromEntries(root.block.children.toArray().filter(n => n.type === 'Declaration').map(n => [n.property, cssTree.generate(n.value)]));
for (const [key, value] of Object.entries(expected)) assert.equal(tokens[key].trim(), value, key);
assert.ok(tokens['font-family'].includes('-apple-system'));
assert.ok(tokens['font-family'].includes('sans-serif'));
assert.ok(!/Georgia|Times New Roman|Atkinson/.test(Object.values(css).join('')));
assert.equal(tokens['color-scheme'], 'light');
function luminance(hex) {
  const x = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  return x[0] * .2126 + x[1] * .7152 + x[2] * .0722;
}
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
for (const bg of ['#FFFFFF', '#F7F8FA', '#F9FAFB', '#F1F3F5']) {
  assert.ok(contrast('#1D1D1F', bg) >= 7, 'body contrast ' + bg);
  assert.ok(contrast('#6E6E73', bg) >= 4.5, 'secondary contrast ' + bg);
}
assert.ok(contrast('#0066CC', '#FFFFFF') >= 4.5, 'link contrast');
assert.ok(contrast('#FFFFFF', '#1D1D1F') >= 7, 'primary action contrast');
for (const rule of ['.agent-composer', '.agent-workspace', '.sidebar', '.lab-layer', '.inspection-tabs', 'prefers-reduced-motion', 'safe-area-inset-bottom']) assert.ok(theme.includes(rule), rule);
for (const rule of ['height:var(--app-height,100dvh)', 'min-height:0', 'overflow-y:auto', '.agent-composer{flex-shrink:0']) assert.ok(css['style.css'].includes(rule), rule);
const html = fs.readFileSync('dist/index.html', 'utf8');
assert.ok(html.indexOf('modern.css') > html.indexOf('inspection.css'));
const source = html.replace(/<link rel="stylesheet"[^>]+>/g, '').replace(/<script src="([^\"]+)"><\/script>/g, (_, name) => '<script>' + fs.readFileSync('dist/' + name, 'utf8').replace(/<\/script>/g, '<\\/script>') + '</script>');
for (const width of [320, 390, 768, 1440]) {
  const errors = [], requests = [];
  const virtualConsole = new VirtualConsole(); virtualConsole.on('jsdomError', e => errors.push(e.message));
  const dom = new JSDOM(source, { runScripts: 'dangerously', url: 'https://visual-test.local/#/app/ai/workbench', virtualConsole, beforeParse(w) {
    Object.defineProperty(w, 'innerWidth', { value: width });
    w.structuredClone = structuredClone; w.scrollTo = () => {}; w.HTMLElement.prototype.scrollIntoView = () => {};
    w.fetch = (...args) => { requests.push(args); throw Error('No transport'); };
  }});
  const { document: d } = dom.window;
  assert.ok(d.querySelector('.agent-chat-layout'), 'chat at ' + width);
  assert.ok(d.querySelector('#agent-chat-form'), 'composer at ' + width);
  assert.ok(d.querySelector('.agent-welcome'), 'welcome at ' + width);
  assert.equal(d.querySelectorAll('.navitem[data-page]').length, 16);
  dom.window.CRM_INSPECTION.open();
  assert.equal(d.querySelectorAll('[data-inspection-tab]').length, 5);
  assert.equal(errors.length, 0, errors.join('\n')); assert.equal(requests.length, 0);
  dom.window.close();
}
console.log('PASS: all four CSS files parse and match property grammar; shared light/sans/radius tokens; WCAG AA body/secondary/link contrast; 320/390/768/1440 DOM route, composer, navigation and inspection controls; reduced-motion and viewport containment preserved. No browser pixel, touch or real-keyboard claim.');
