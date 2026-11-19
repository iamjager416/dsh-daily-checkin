/**
 * GeeTest v4 滑块求解：Canny 边缘 + 归一化互相关模板匹配。
 * 对应原插件 geeked/slide.py（OpenCV Canny + TM_CCOEFF_NORMED）。
 */

const GAUSS = [1, 4, 6, 4, 1];
const GAUSS_SUM = 16;

function gaussianBlur({ width, height, gray }) {
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -2; k <= 2; k += 1) {
        const xx = x + k;
        if (xx >= 0 && xx < width) sum += gray[y * width + xx] * GAUSS[k + 2];
      }
      tmp[y * width + x] = sum / GAUSS_SUM;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let k = -2; k <= 2; k += 1) {
        const yy = y + k;
        if (yy >= 0 && yy < height) sum += tmp[yy * width + x] * GAUSS[k + 2];
      }
      out[y * width + x] = sum / GAUSS_SUM;
    }
  }
  return { width, height, gray: out };
}

/** Canny：Sobel(L1) + 非极大值抑制 + 双阈值滞后（与 cv2.Canny(100,200) 对齐）。 */
export function canny(image, lowThreshold = 100, highThreshold = 200) {
  const blurred = gaussianBlur(image);
  const { width, height } = blurred;
  const gray = blurred.gray;
  const gx = new Float32Array(width * height);
  const gy = new Float32Array(width * height);
  const mag = new Float32Array(width * height);
  const at = (x, y) => gray[Math.min(Math.max(y, 0), height - 1) * width + Math.min(Math.max(x, 0), width - 1)];

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const sx =
        -at(x - 1, y - 1) + at(x + 1, y - 1) +
        -2 * at(x - 1, y) + 2 * at(x + 1, y) +
        -at(x - 1, y + 1) + at(x + 1, y + 1);
      const sy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      gx[y * width + x] = sx;
      gy[y * width + x] = sy;
      mag[y * width + x] = Math.abs(sx) + Math.abs(sy);
    }
  }

  // 非极大值抑制
  const thin = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const value = mag[y * width + x];
      if (value === 0) continue;
      const angle = (Math.atan2(gy[y * width + x], gx[y * width + x]) * 180) / Math.PI;
      const direction = ((angle % 180) + 180) % 180;
      let before;
      let after;
      if (direction < 22.5 || direction >= 157.5) {
        before = mag[y * width + x - 1];
        after = mag[y * width + x + 1];
      } else if (direction < 67.5) {
        before = mag[(y - 1) * width + x + 1];
        after = mag[(y + 1) * width + x - 1];
      } else if (direction < 112.5) {
        before = mag[(y - 1) * width + x];
        after = mag[(y + 1) * width + x];
      } else {
        before = mag[(y - 1) * width + x - 1];
        after = mag[(y + 1) * width + x + 1];
      }
      if (value >= before && value >= after) thin[y * width + x] = value;
    }
  }

  // 双阈值 + 滞后
  const strong = new Uint8Array(width * height);
  const weak = new Uint8Array(width * height);
  for (let i = 0; i < thin.length; i += 1) {
    if (thin[i] >= highThreshold) strong[i] = 1;
    else if (thin[i] >= lowThreshold) weak[i] = 1;
  }
  const stack = [];
  for (let i = 0; i < strong.length; i += 1) if (strong[i]) stack.push(i);
  while (stack.length > 0) {
    const index = stack.pop();
    const x = index % width;
    const y = (index - x) / width;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const ni = ny * width + nx;
        if (weak[ni] && !strong[ni]) {
          strong[ni] = 1;
          stack.push(ni);
        }
      }
    }
  }

  const edges = new Float32Array(width * height);
  for (let i = 0; i < strong.length; i += 1) edges[i] = strong[i] ? 255 : 0;
  return { width, height, data: edges };
}

/**
 * TM_CCOEFF_NORMED 模板匹配（模板小于图像），返回得分最高位置。
 * @param {{width:number,height:number,data:Float32Array}} image
 * @param {{width:number,height:number,data:Float32Array}} template
 */
export function matchTemplateCcoeff(image, template) {
  const { width: W, height: H, data: img } = image;
  const { width: tw, height: th, data: tpl } = template;
  if (tw > W || th > H) throw new Error("模板大于图像");
  const n = tw * th;

  // 积分图（和 / 平方和）
  const integral = new Float64Array((W + 1) * (H + 1));
  const integral2 = new Float64Array((W + 1) * (H + 1));
  for (let y = 1; y <= H; y += 1) {
    let rowSum = 0;
    let rowSum2 = 0;
    for (let x = 1; x <= W; x += 1) {
      const value = img[(y - 1) * W + (x - 1)];
      rowSum += value;
      rowSum2 += value * value;
      integral[y * (W + 1) + x] = integral[(y - 1) * (W + 1) + x] + rowSum;
      integral2[y * (W + 1) + x] = integral2[(y - 1) * (W + 1) + x] + rowSum2;
    }
  }
  const windowSum = (x, y, w, h) => {
    const x1 = x;
    const y1 = y;
    const x2 = x + w;
    const y2 = y + h;
    return (
      integral[y2 * (W + 1) + x2] -
      integral[y1 * (W + 1) + x2] -
      integral[y2 * (W + 1) + x1] +
      integral[y1 * (W + 1) + x1]
    );
  };
  const windowSum2 = (x, y, w, h) => {
    const x1 = x;
    const y1 = y;
    const x2 = x + w;
    const y2 = y + h;
    return (
      integral2[y2 * (W + 1) + x2] -
      integral2[y1 * (W + 1) + x2] -
      integral2[y2 * (W + 1) + x1] +
      integral2[y1 * (W + 1) + x1]
    );
  };

  // 模板的均值/方差与非零边缘点（稀疏相关）
  let sumT = 0;
  const points = [];
  for (let ty = 0; ty < th; ty += 1) {
    for (let tx = 0; tx < tw; tx += 1) {
      const value = tpl[ty * tw + tx];
      sumT += value;
      if (value !== 0) points.push({ ty, tx, value });
    }
  }
  const meanT = sumT / n;
  let varT = 0;
  for (let i = 0; i < tpl.length; i += 1) {
    const d = tpl[i] - meanT;
    varT += d * d;
  }

  let best = { x: 0, y: 0, score: -2 };
  for (let y = 0; y <= H - th; y += 1) {
    for (let x = 0; x <= W - tw; x += 1) {
      const s = windowSum(x, y, tw, th);
      const s2 = windowSum2(x, y, tw, th);
      const mean = s / n;
      const variance = Math.max(s2 / n - mean * mean, 0);
      if (variance <= 0) continue;
      let dot = 0;
      for (const point of points) {
        dot += point.value * img[(y + point.ty) * W + (x + point.tx)];
      }
      const numerator = dot - mean * sumT;
      const denominator = Math.sqrt(variance * varT);
      const score = denominator > 0 ? numerator / denominator : 0;
      if (score > best.score) best = { x, y, score };
    }
  }
  return best;
}

/**
 * 求滑块缺口位置（对齐原插件：返回 top_left.x + w/2 - 41）。
 * @param {Buffer} slidePng
 * @param {Buffer} bgPng
 */
export function solveSlide(slidePng, bgPng, decodePng, toGray) {
  const slideGray = toGray(decodePng(slidePng));
  const bgGray = toGray(decodePng(bgPng));
  const edgePiece = canny(slideGray);
  const edgeBg = canny(bgGray);
  const { x } = matchTemplateCcoeff(edgeBg, edgePiece);
  const centerX = x + Math.floor(edgePiece.width / 2);
  return centerX - 41;
}
