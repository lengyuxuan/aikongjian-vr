// @ts-ignore
import workJSON from './work_json.json';
// import workJSON from '@realsee/open-works/virtual/816lPVZQkQDF5XOpPo/work.json';
import { Five } from '@realsee/five';
import './style.css';

const $app = document.querySelector<HTMLElement>('#app') as HTMLElement;

// five初始化参数请参考
// https://unpkg.com/@realsee/five@latest/docs/interfaces/five.FiveInitArgs.html
const five = new Five({
  imageOptions: {
    // 初始512开启动态瓦片加载，可提升点位加载速度
    size: 512,
  },
  textureOptions: {
    // 关闭模型贴图自动缩放，加载高精度模型贴图，
    // 注意，低性能的机器大模型场景容易崩溃
    autoResize: false,
  },
});

five.load(workJSON);

five.appendTo($app);

// 当容器div尺寸变化时进行画布刷新
window.addEventListener('resize', () => five.refresh());

// 添加切换按钮
const $button = document.createElement('button');

$button.innerText = '切换成模型态';

$button.addEventListener('click', (ev) => {
  console.log(ev);
  // 当前为全景模式
  if (five.getCurrentState().mode === Five.Mode.Panorama) {
    five.changeMode(Five.Mode.Floorplan);
    return;
  }
  // 当前为模型态
  if (five.getCurrentState().mode === Five.Mode.Floorplan) {
    five.changeMode(Five.Mode.Panorama);
    return;
  }
});

five.on('modeChange', (mode) => {
  if (mode === Five.Mode.Panorama) {
    $button.innerText = '切换成模型态';
  }
  if (mode === Five.Mode.Floorplan) {
    $button.innerText = '切换成全景态';
  }
});

$button.classList.add('btn');

$app.appendChild($button);

// 链接到素材打包工具
const $toolLink = document.createElement('a');
$toolLink.href = './download.html';
$toolLink.textContent = '打包工具';
$toolLink.classList.add('tool-link');
$app.appendChild($toolLink);
