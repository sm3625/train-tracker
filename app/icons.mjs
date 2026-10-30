#!/usr/bin/env node
// Makes every app icon and launch screen from the SVGs in assets/:
//
//   npm run icons
//
//   icon-only.svg                        the icon, square and full-bleed (iOS rounds it; older Android launchers)
//   icon-background.svg, icon-foreground.svg   Android's adaptive icon, as two layers the launcher can move apart
//   splash.svg, splash-dark.svg          the launch screens, light and dark
//   icon-dark.svg                        iOS's icon in dark mode
//   icon-monochrome.svg                  Android 13+ themed icons: one colour, which the launcher tints
//
// @capacitor/assets sizes the first five for each platform; it makes neither the dark iOS icon nor the themed Android
// one, so this adds them afterwards. Each run replaces what the last one made.
import { readFile, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(dir, 'assets');
const require = createRequire(import.meta.url);
// sharp comes with @capacitor/assets, which uses it to read the SVGs
const sharp = createRequire(require.resolve('@capacitor/assets'))('sharp');

const run = spawnSync('npx', ['capacitor-assets', 'generate', '--ios', '--android'], { cwd: dir, stdio: 'inherit' });
if (run.status !== 0) process.exit(run.status || 1);

// iOS: the dark-mode icon, beside the one @capacitor/assets made
const iconSet = path.join(dir, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
const darkName = 'AppIcon-512@2x-dark.png';
await sharp(path.join(assets, 'icon-dark.svg')).resize(1024, 1024).flatten({ background: '#000000' }).png().toFile(path.join(iconSet, darkName));
const contents = JSON.parse(await readFile(path.join(iconSet, 'Contents.json'), 'utf8'));
contents.images = contents.images.filter((i) => !i.appearances).concat({
  appearances: [{ appearance: 'luminosity', value: 'dark' }], idiom: 'universal', size: '1024x1024', filename: darkName, platform: 'ios',
});
await writeFile(path.join(iconSet, 'Contents.json'), JSON.stringify(contents, null, 2) + '\n');

// Android: @capacitor/assets draws the adaptive icon's layers at launcher-icon size (48 dp), and the launcher then
// stretches them over the 72 dp they fill. Drawn at 72 dp instead, they stay sharp.
const res = path.join(dir, 'android', 'app', 'src', 'main', 'res');
const DENSITIES = { ldpi: 0.75, mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [density, scale] of Object.entries(DENSITIES)) {
  for (const layer of ['foreground', 'background']) {
    const px = Math.round(72 * scale);
    await sharp(path.join(assets, `icon-${layer}.svg`)).resize(px, px).png().toFile(path.join(res, `mipmap-${density}`, `ic_launcher_${layer}.png`));
  }
}

// Android: the themed icon, as a vector drawn on the adaptive icon's grid (the same inset as its other two layers)
const mono = await readFile(path.join(assets, 'icon-monochrome.svg'), 'utf8');
const paths = [...mono.matchAll(/<path d="([^"]+)"[^>]*?(?:fill-opacity="([\d.]+)")?\s*\/>/g)]
  .map(([, d, alpha]) => `    <path android:fillColor="#FF000000"${alpha ? ` android:fillAlpha="${alpha}"` : ''} android:pathData="${d}" />`);
if (!paths.length) { console.error('No paths in assets/icon-monochrome.svg.'); process.exit(1); }
await writeFile(path.join(res, 'drawable', 'ic_launcher_monochrome.xml'), `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by icons.mjs from assets/icon-monochrome.svg. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp" android:viewportWidth="1024" android:viewportHeight="1024">
${paths.join('\n')}
</vector>
`);
for (const name of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
  const file = path.join(res, 'mipmap-anydpi-v26', name);
  const xml = (await readFile(file, 'utf8')).replace(/\s*<monochrome>[\s\S]*?<\/monochrome>/, '');
  await writeFile(file, xml.replace('</adaptive-icon>', `    <monochrome>
        <inset android:drawable="@drawable/ic_launcher_monochrome" android:inset="16.7%" />
    </monochrome>
</adaptive-icon>`));
}
console.log('Added the dark iOS icon and the themed Android icon.');
