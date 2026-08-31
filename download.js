const got = require('got');
const { pipeline } = require('stream/promises');
const json = require('./work_json.json'); // 这个json是用户提供的一个url下载下来的
const path = require('node:path/posix');
const fs = require('node:fs');

async function download(url, file) {
  const readStream = got.stream(url);
  const writeStream = fs.createWriteStream(file);
  await pipeline(readStream, writeStream);
}

const dir = path.join(__dirname, 'vr');
(async () => {
  const model = json.model;
  const modelUrl = path.join(json.base_url, model.file_url);
  await fs.promises.mkdir(path.join(dir, path.dirname(model.file_url)), {
    recursive: true,
  });
  await download(modelUrl, path.join(dir, model.file_url));

  await fs.promises.mkdir(path.join(dir, model.material_base_url), {
    recursive: true,
  });
  for (const material_texture of model.material_textures) {
    await download(path.join(json.base_url, model.material_base_url, material_texture), path.join(dir, model.material_base_url, material_texture));
  }

  const positions = ['back', 'down', 'front', 'left', 'right', 'up'];
  for (const item of json.panorama.list) {
    for (const position of positions) {
      await fs.promises.mkdir(path.join(dir, path.dirname(item[position])), {
        recursive: true,
      });
      await download(path.join(json.base_url, item[position]), path.join(dir, item[position]));
    }
  }

  await fs.promises.mkdir(path.join(dir, path.dirname(json.picture_url)), {
    recursive: true,
  });
  await download(path.join(json.base_url, json.picture_url), path.join(dir, json.picture_url));

  await fs.promises.mkdir(path.join(dir, path.dirname(json.title_picture_url)), {
    recursive: true,
  });
  await download(path.join(json.base_url, json.title_picture_url), path.join(dir, json.title_picture_url));
})();
