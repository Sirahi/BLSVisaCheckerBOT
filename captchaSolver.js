const Tesseract = require('tesseract.js')
const sharp = require('sharp')
const { By, until } = require('selenium-webdriver')
const harvest = require('./harvest')

let ocrStats = {
  totalAttempts: 0,
  successfulReads: 0,
  threeDigitReads: 0,
  targetMatches: 0
}

function calculateOCRSuccessRate() {
  if (ocrStats.totalAttempts === 0) return 0;
  return (ocrStats.threeDigitReads / ocrStats.totalAttempts) * 100;
}

function resetOCRStats() {
  ocrStats = {
    totalAttempts: 0,
    successfulReads: 0,
    threeDigitReads: 0,
    targetMatches: 0
  }
}

// ============================================
// HELPER: image processing pipeline
// ============================================

// ============================================
// ADAPTIVE PREPROCESSING (Pakistan/Intiana portal)
// ------------------------------------------------
// Fixed global thresholds erased pale digits: tiles whose glyphs differ from
// the background in HUE but not BRIGHTNESS came out blank. These three steps
// replaced 20 hand-tuned colour configs and took offline accuracy on 54 real
// captured tiles from 74.1% to 94.4%. Benchmark: ../captcha-lab/bench4.js
// ============================================

// Threshold derived from THIS tile's histogram instead of a hardcoded number.
function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (const v of gray) hist[v]++;
  const total = gray.length;
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

// Background = modal colour. Digits differ from it in hue, so distance from
// the background separates them regardless of which colour they are.
function colourDistanceMap(data, w, h) {
  const bucket = {};
  const q = v => (v >> 4) << 4;
  for (let i = 0; i < data.length; i += 3) {
    const k = `${q(data[i])},${q(data[i + 1])},${q(data[i + 2])}`;
    bucket[k] = (bucket[k] || 0) + 1;
  }
  const [br, bg, bb] = Object.entries(bucket).sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  const dist = new Float32Array(w * h); let max = 1;
  for (let p = 0, i = 0; i < data.length; i += 3, p++) {
    const d = Math.hypot(data[i] - br, data[i + 1] - bg, data[i + 2] - bb);
    dist[p] = d; if (d > max) max = d;
  }
  const out = Buffer.alloc(w * h);
  for (let p = 0; p < dist.length; p++) out[p] = Math.round((dist[p] / max) * 255);
  return out;
}

// Keep large blobs (digit strokes), drop small ones (crosshatch speckle).
// This is the step that stopped Tesseract returning empty on noisy tiles.
function filterComponents(bin, w, h, minPx) {
  const lbl = new Int32Array(w * h).fill(-1);
  const sizes = []; const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (bin[i] === 0 || lbl[i] !== -1) continue;
    const id = sizes.length; let n = 0;
    stack.push(i); lbl[i] = id;
    while (stack.length) {
      const pq = stack.pop(); n++;
      const x = pq % w, y = (pq / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const qq = ny * w + nx;
        if (bin[qq] === 0 && lbl[qq] === -1) { lbl[qq] = id; stack.push(qq); }
      }
    }
    sizes.push(n);
  }
  const out = Buffer.alloc(w * h, 255);
  for (let i = 0; i < w * h; i++) {
    const id = lbl[i];
    if (id >= 0 && sizes[id] >= minPx) out[i] = 0;
  }
  return out;
}

async function preprocessAdaptive(imgBuffer, cfg) {
  const { data, info } = await sharp(imgBuffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const map = colourDistanceMap(data, info.width, info.height);
  let pipe = sharp(map, { raw: { width: info.width, height: info.height, channels: 1 } });
  if (cfg.blur) pipe = pipe.blur(cfg.blur);
  pipe = pipe.normalize();
  const g = await pipe.clone().raw().toBuffer();
  const thr = otsuThreshold(g);
  const scale = cfg.resize || 3;
  const binPng = await pipe.resize(info.width * scale, info.height * scale)
    .threshold(thr).negate().png().toBuffer();
  // component filter on the binarised, upscaled image
  const bi = await sharp(binPng).grayscale().raw().toBuffer({ resolveWithObject: true });
  const bin = Buffer.from(bi.data).map(v => (v < 128 ? 0 : 255));
  const cleaned = filterComponents(bin, bi.info.width, bi.info.height, cfg.minPx || 120);
  // Tesseract expects document-like input: white margin, ~300dpi
  return sharp(cleaned, { raw: { width: bi.info.width, height: bi.info.height, channels: 1 } })
    .extend({ top: 40, bottom: 40, left: 40, right: 40, background: '#fff' })
    .withMetadata({ density: 300 }).png().toBuffer();
}

// HELPER: run OCR for a single tile
// TURBO MODE: multiple methods + early exit
// ============================================
async function runOCRWithVoting(imgBuffer, boxIndex) {
  // Adaptive configs. One is usually enough (93% alone); the spread covers
  // edge cases. Was 20 fixed-threshold colour configs at 74.1%.
  const ocrConfigs = [
    { name: 'cd_b2_cc120',  blur: 2,   resize: 3, minPx: 120 },
    { name: 'cd_b2_cc60',   blur: 2,   resize: 3, minPx: 60 },
    { name: 'cd_b3_cc120',  blur: 3,   resize: 3, minPx: 120 },
    { name: 'cd_b15_cc120', blur: 1.5, resize: 3, minPx: 120 },
    { name: 'cd_b2_cc200',  blur: 2,   resize: 3, minPx: 200 },
    { name: 'cd_b25_cc80',  blur: 2.5, resize: 3, minPx: 80 },
  ];

  // Collect results for voting
  const results = {};
  const allResults = [];
  const EARLY_EXIT_VOTES = 3; // stop once 3+ votes agree (for speed)

  for (const config of ocrConfigs) {
    try {
      ocrStats.totalAttempts++;

      // Process the image
      const processedBuffer = await preprocessAdaptive(imgBuffer, config);

      // Run OCR - digits-only optimisation
      const { data: { text, confidence } } = await Tesseract.recognize(
        processedBuffer,
        'eng',
        {
          logger: m => { },
          tessedit_char_whitelist: '0123456789',
          tessedit_pageseg_mode: '7', // Single TEXT LINE. PSM 8 (single word) measured ~44% vs 94% here.
          tessedit_ocr_engine_mode: '1', // LSTM only - faster
          tessedit_create_hocr: '0', // disable HOCR output (for speed)
          tessedit_create_tsv: '0', // disable TSV output (for speed)
          tessedit_create_pdf: '0', // disable PDF output (for speed)
          preserve_interword_spaces: '0', // do not preserve interword spaces (not needed for digits)
          classify_bln_numeric_mode: '1', // numeric mode - optimised for digits only
          textord_min_linesize: '2.5', // minimum line size (for small digits)
          classify_enable_learning: '0' // disable adaptive learning (for speed)
        }
      );

      // Keep digits only
      const cleanText = text.replace(/\D/g, '');

      // Check whether it is 3 digits
      if (/^\d{3}$/.test(cleanText)) {
        ocrStats.threeDigitReads++;

        // Count for voting
        if (!results[cleanText]) {
          results[cleanText] = { count: 0, configs: [], totalConfidence: 0 };
        }
        results[cleanText].count++;
        results[cleanText].configs.push(config.name);
        results[cleanText].totalConfidence += confidence || 0;

        allResults.push({ text: cleanText, config: config.name, confidence });

        // EARLY EXIT: stop once enough votes agree
        if (results[cleanText].count >= EARLY_EXIT_VOTES) {
          break;
        }
      }
    } catch (e) {
      // Skip silently
    }
  }

  // Find the result with the most votes
  let bestResult = null;
  let maxVotes = 0;

  for (const [text, data] of Object.entries(results)) {
    if (data.count > maxVotes) {
      maxVotes = data.count;
      bestResult = {
        text,
        votes: data.count,
        avgConfidence: data.totalConfidence / data.count,
        configs: data.configs
      };
    }
  }

  return { bestResult, allResults, results };
}

// ============================================
// Find the target number
// ============================================
async function findTargetNumber(driver) {
  let isInIframe = false;

  // Find the target number text
  let labelDivs = await driver.findElements(By.css('div.box-label'));

  if (labelDivs.length === 0) {
    labelDivs = await driver.findElements(By.xpath("//*[contains(text(), 'number ') or contains(text(), 'Please select')]"));
  }

  let visibleDivs = [];
  for (let div of labelDivs) {
    try {
      const isDisplayed = await div.isDisplayed();
      if (isDisplayed) {
        const text = await div.getText();
        const opacity = await div.getCssValue('opacity');
        const display = await div.getCssValue('display');
        const visibility = await div.getCssValue('visibility');

        if (opacity === '1' && display !== 'none' && visibility !== 'hidden') {
          const zIndexRaw = await div.getCssValue('z-index');
          const zIndex = parseInt(zIndexRaw) || 0;
          const rect = await div.getRect();
          visibleDivs.push({ div, zIndex, y: rect.y, text });
        }
      }
    } catch (e) { }
  }

  if (visibleDivs.length === 0) {
    if (isInIframe) await driver.switchTo().defaultContent();
    // PK diagnostic: captures show no iframe and isInIframe is never set true,
    // so the tiles are expected in the main document. If that assumption is
    // wrong on this portal, say so here instead of failing opaquely.
    let frameHint = '';
    try {
      const frames = await driver.findElements(By.css('iframe'));
      const visible = [];
      for (const f of frames) {
        try { if (await f.isDisplayed()) visible.push(await f.getAttribute('src') || '(no src)'); } catch (e) { }
      }
      if (visible.length) {
        frameHint = ` | ${visible.length} visible iframe(s) on page: ${visible.join(', ')}` +
                    ` -- captcha may live inside one; frame switching would be needed.`;
      } else {
        frameHint = ' | no visible iframes - captcha is not frame-hosted.';
      }
    } catch (e) { }
    throw new Error(`Target number text not found! (div.box-label not found)${frameHint}`);
  }

  // Take the topmost visible div
  visibleDivs.sort((a, b) => b.zIndex - a.zIndex || a.y - b.y);
  const visibleText = visibleDivs[0].text;

  const match = visibleText.match(/number (\d+)/);
  if (isInIframe) await driver.switchTo().defaultContent();

  if (match) {
    return match[1];
  }

  throw new Error('Target number not found!');
}

// ============================================
// Select the tiles - WITH THE VOTING SYSTEM
// ============================================
async function selectCaptchaBoxes(driver, targetNumber, kind = 'captcha') {
  let isInIframe = false;

  // Harvest every tile of this challenge into ../captcha-lab/harvest/ so the
  // offline corpus grows on every run. Saved regardless of outcome.
  harvest.startChallenge(targetNumber, kind);

  // Find the tiles
  let boxImgs = await driver.findElements(By.css('div.col-4 img'));

  if (boxImgs.length === 0) {
    boxImgs = await driver.findElements(By.css('img[src*="data:image"]'));
  }

  // Collect all tiles with position and z-index
  const allBoxes = [];
  for (let [i, img] of boxImgs.entries()) {
    try {
      const rect = await img.getRect();
      if (rect.width < 10 || rect.height < 10) continue;
      const parentDiv = await img.findElement(By.xpath('..'));
      const zIndexRaw = await parentDiv.getCssValue('z-index');
      const zIndex = parseInt(zIndexRaw) || 1;
      const posKey = `${Math.round(rect.y)}_${Math.round(rect.x)}`;
      allBoxes.push({ index: i, img, parentDiv, zIndex, rect, posKey });
    } catch (e) { }
  }

  // Group by position, take the topmost tile at each position
  const positionMap = {};
  for (const box of allBoxes) {
    if (!positionMap[box.posKey]) positionMap[box.posKey] = [];
    positionMap[box.posKey].push(box);
  }

  const boxesToScan = [];
  for (const [posKey, boxes] of Object.entries(positionMap)) {
    boxes.sort((a, b) => b.zIndex - a.zIndex);
    boxesToScan.push(boxes[0]);
  }

  boxesToScan.sort((a, b) => {
    if (Math.abs(a.rect.y - b.rect.y) > 20) return a.rect.y - b.rect.y;
    return a.rect.x - b.rect.x;
  });

  let clickedCount = 0;

  for (let [idx, box] of boxesToScan.entries()) {
    const { index: i, img, parentDiv } = box;

    try {
      // Read the base64 image
      const base64src = await img.getAttribute('src');
      if (!base64src || !base64src.includes('base64')) continue;

      const imgBuffer = Buffer.from(base64src.split(',')[1], 'base64');

      // Run OCR with voting
      const { bestResult } = await runOCRWithVoting(imgBuffer, i);

      // Save the tile before acting on it. Unreadable tiles are saved too -
      // those are the samples worth having.
      harvest.saveTile(i, base64src, bestResult, bestResult && bestResult.text === targetNumber);

      if (bestResult) {
        // Does it match the target number?
        if (bestResult.text === targetNumber) {
          ocrStats.targetMatches++;

          // 🛡️ CHECK IF ALREADY SELECTED - do not click if it has the img-selected class!
          let alreadySelected = false;
          try {
            const imgClass = await img.getAttribute('class');
            if (imgClass && imgClass.includes('img-selected')) {
              alreadySelected = true;
              clickedCount++; // Count it but do not click
            }
          } catch (e) { }

          if (!alreadySelected) {
            // Click immediately - avoids a stale element
            let clicked = false;
            try {
              await parentDiv.click();
              clicked = true;
            } catch (e1) {
              try {
                await driver.executeScript('arguments[0].click();', parentDiv);
                clicked = true;
              } catch (e2) {
                try {
                  await img.click();
                  clicked = true;
                } catch (e3) {
                  await driver.executeScript('arguments[0].click();', img);
                  clicked = true;
                }
              }
            }

            if (clicked) {
              clickedCount++;
            }
          }
        }
      }
    } catch (e) {
      // Continue silently
    }
  }

  let submitted = false;

  const submitMethods = [
    { selector: 'i#submit', name: 'i#submit' },
    { selector: 'div.img-action-div[onclick*="onSubmit"]', name: 'div.img-action-div' },
    { selector: 'button[type="submit"]', name: 'button[type=submit]' },
    { selector: '.submit-btn', name: '.submit-btn' }
  ];

  for (const method of submitMethods) {
    if (submitted) break;
    try {
      const elem = await driver.findElement(By.css(method.selector));
      await driver.executeScript("arguments[0].scrollIntoView({block: 'center'});", elem);
      await driver.sleep(300);
      await driver.executeScript("arguments[0].click();", elem);
      submitted = true;
    } catch (e) { }
  }

  // Last resort: call the JS function
  if (!submitted) {
    try {
      await driver.executeScript('if(typeof onSubmit === "function") onSubmit();');
      submitted = true;
    } catch (e) { }
  }

  const submitOk = submitted;
  console.log(
    `Captcha ${targetNumber}: ${clickedCount}/${boxesToScan.length} tiles${submitOk ? ', submitted' : ', no submit'}`
  );

  harvest.endChallenge({
    submitted: submitOk,
    clickedCount,
    scanned: boxesToScan.length,
  });

  await driver.sleep(2000);
  if (isInIframe) await driver.switchTo().defaultContent();
}

// ============================================
// MAIN ENTRY POINT: single-shot captcha solving
// ============================================
/**
 * Solve the captcha that is ON SCREEN RIGHT NOW. Exactly one attempt.
 *
 * No retries, no refreshes, no navigation, no #btnSubmit click. The state
 * machine owns all of that - it can see the page, this function cannot.
 * Returns a result object instead of throwing for ordinary failure.
 */
async function solveVisibleCaptcha(driver, { isLogin = false } = {}) {
  resetOCRStats();
  try {
    const target = await findTargetNumber(driver);
    await selectCaptchaBoxes(driver, target, isLogin ? 'login' : 'entry');
    await driver.switchTo().defaultContent();

    // Accept any alert the portal raised, and report it - the caller decides.
    let alertText = null;
    try {
      while (true) {
        await driver.wait(until.alertIsPresent(), 800);
        const alert = await driver.switchTo().alert();
        alertText = await alert.getText();
        await alert.accept();
        await driver.sleep(300);
      }
    } catch (e) { /* no more alerts */ }

    if (alertText && /maximum number of captcha request|Please try after sometime/i.test(alertText)) {
      return { ok: false, target, clicked: 0, reason: 'RATE_LIMITED' };
    }
    if (alertText) {
      return { ok: false, target, clicked: 0, reason: `ALERT: ${alertText}` };
    }
    return { ok: true, target, clicked: 0, reason: null };
  } catch (e) {
    try { await driver.switchTo().defaultContent(); } catch (e2) { /* ignore */ }
    return { ok: false, target: null, clicked: 0, reason: e.message };
  }
}

module.exports = {
  // exported so ../captcha-lab can benchmark the real pipeline offline
  preprocessAdaptive,
  otsuThreshold,
  solveVisibleCaptcha,
  findTargetNumber,
  selectCaptchaBoxes,
  calculateOCRSuccessRate,
  resetOCRStats,
  ocrStats
}

