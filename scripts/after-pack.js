// Removes optional Electron runtime files that this app does not use.
// dxcompiler/vk_swiftshader/vulkan are only needed for WebGPU and software
// rendering fallbacks; the widget uses plain CSS/canvas.
const fs = require('node:fs');
const path = require('node:path');

const OPTIONAL_FILES = [
  'dxcompiler.dll',
  'vk_swiftshader.dll',
  'vk_swiftshader_icd.json',
  'vulkan-1.dll',
];

module.exports = async function afterPack(context) {
  for (const name of OPTIONAL_FILES) {
    const file = path.join(context.appOutDir, name);
    try {
      fs.rmSync(file, { force: true });
      console.log(`[after-pack] removed ${name}`);
    } catch (error) {
      console.warn(`[after-pack] could not remove ${name}: ${error.message}`);
    }
  }
};
