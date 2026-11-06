const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const dir = process.argv[2]
const out = process.argv[3] || path.join(dir, 'preview-sheet.jpg')
if (!dir) {
  console.error('Usage: node scripts/make_ppt_preview_sheet.cjs preview-dir [out.jpg]')
  process.exit(1)
}

function slideNo(name) {
  const match = String(name).match(/(\d+)/)
  return match ? Number(match[1]) : 0
}

async function main() {
  const files = fs
    .readdirSync(dir)
    .filter((name) => /\.png$/i.test(name))
    .sort((a, b) => slideNo(a) - slideNo(b))
    .map((name) => path.join(dir, name))
  const thumbW = 480
  const thumbH = 270
  const gap = 18
  const cols = 3
  const rows = Math.ceil(files.length / cols)
  const canvasW = cols * thumbW + (cols + 1) * gap
  const canvasH = rows * (thumbH + 34) + (rows + 1) * gap
  const composites = []
  for (let i = 0; i < files.length; i += 1) {
    const row = Math.floor(i / cols)
    const col = i % cols
    const left = gap + col * (thumbW + gap)
    const top = gap + row * (thumbH + 34 + gap)
    const image = await sharp(files[i]).resize(thumbW, thumbH, { fit: 'contain' }).jpeg().toBuffer()
    const label = Buffer.from(
      `<svg width="${thumbW}" height="28"><rect width="100%" height="100%" fill="#121412"/><text x="12" y="19" fill="#ffb77d" font-size="16" font-family="Arial">Slide ${i + 1}</text></svg>`,
    )
    composites.push({ input: image, left, top })
    composites.push({ input: label, left, top: top + thumbH + 6 })
  }
  await sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: '#0d0f0d',
    },
  })
    .composite(composites)
    .jpeg({ quality: 88 })
    .toFile(out)
  console.log(out)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
