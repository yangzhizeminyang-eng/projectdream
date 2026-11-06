const fs = require('fs')
const JSZip = require('jszip')

const file = process.argv[2]
if (!file) {
  console.error('Usage: node scripts/inspect_pptx.cjs deck.pptx')
  process.exit(1)
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

async function main() {
  const zip = await JSZip.loadAsync(fs.readFileSync(file))
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]))
  let transitions = 0
  console.log(`slides=${slides.length}`)
  for (const slide of slides) {
    const xml = await zip.file(slide).async('string')
    if (xml.includes('<p:transition')) transitions += 1
    const texts = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g))
      .map((match) => decodeXmlText(match[1]).trim())
      .filter(Boolean)
    console.log(`${slide.replace('ppt/slides/', '')}: ${texts.slice(0, 6).join(' | ')}`)
  }
  console.log(`transitions=${transitions}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
