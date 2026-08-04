const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
const publicFiles = [
  'index.html',
  'styles.css',
  'script.js',
  'i18n.js',
  'manifest.json',
  'logo.svg',
  'musir-logo.jpg',
  'admin.html',
  'admin.css',
  'admin.js',
];

function safeInlineScript(source) {
  return source.replace(/<\/script/gi, '<\\/script');
}

function inlinePage(file, stylesheetNames, scriptNames) {
  let html = fs.readFileSync(path.join(root, file), 'utf8');
  const logo = fs.readFileSync(path.join(root, 'musir-logo.jpg')).toString('base64');
  html = html.replaceAll('src="musir-logo.jpg"', `src="data:image/jpeg;base64,${logo}"`);
  for (const stylesheet of stylesheetNames) {
    const css = fs.readFileSync(path.join(root, stylesheet), 'utf8');
    const escaped = stylesheet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(
      new RegExp(`<link\\s+rel="stylesheet"\\s+href="${escaped}(?:\\?[^\"]*)?">`),
      () => `<style data-source="${stylesheet}">\n${css}\n</style>`
    );
  }
  for (const script of scriptNames) {
    const source = safeInlineScript(fs.readFileSync(path.join(root, script), 'utf8'));
    const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(
      new RegExp(`<script\\s+src="${escaped}(?:\\?[^\"]*)?"(?:\\s+defer)?><\\/script>`),
      () => `<script data-source="${script}">\n${source}\n</script>`
    );
  }
  fs.writeFileSync(path.join(output, file), html, 'utf8');
}

fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const file of publicFiles) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}
inlinePage('index.html', ['styles.css'], ['i18n.js', 'script.js']);
inlinePage('admin.html', ['styles.css', 'admin.css'], ['i18n.js', 'admin.js']);
console.log(`Prepared ${publicFiles.length} public files for Vercel.`);
