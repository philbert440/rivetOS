import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyUnembeddable } from './classify.js'

test('null/undefined/empty content returns null', () => {
  assert.equal(classifyUnembeddable(''), null)
  assert.equal(classifyUnembeddable(null), null)
  assert.equal(classifyUnembeddable(undefined), null)
})

test('plain text returns null', () => {
  assert.equal(classifyUnembeddable('hello world this is a normal message'), null)
  assert.equal(classifyUnembeddable('Phil said: "let us merge the PR"'), null)
})

test('media-marker pattern is detected', () => {
  assert.equal(classifyUnembeddable('[media attached: image.png]'), 'media-marker')
  assert.equal(classifyUnembeddable('  [Media attached: foo]'), 'media-marker')
  assert.equal(
    classifyUnembeddable('[media attached: video.mp4]\nplus some caption'),
    'media-marker',
  )
})

test('MEDIA: prefix is detected', () => {
  assert.equal(classifyUnembeddable('MEDIA: image/png'), 'media-prefix')
  assert.equal(classifyUnembeddable('media: foo'), 'media-prefix')
})

test('data: URL is detected', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAA'
  assert.equal(classifyUnembeddable(dataUrl), 'base64-data-url')
})

test('PNG magic-bytes base64 is detected', () => {
  // 250+ chars of base64-alphabet after the PNG header
  const pngHeader = 'iVBORw0KGgo' + 'A'.repeat(250)
  assert.equal(classifyUnembeddable(pngHeader), 'base64-png')
})

test('JPEG magic-bytes base64 is detected', () => {
  const jpegHeader = '/9j/' + 'A'.repeat(600)
  assert.equal(classifyUnembeddable(jpegHeader), 'base64-jpeg')
})

test('long base64 blob with no whitespace is detected', () => {
  // 2000 chars of pure base64 alphabet, no spaces
  const blob = 'A'.repeat(2000)
  assert.equal(classifyUnembeddable(blob), 'base64-blob')
})

test('long string with mostly real text is NOT misclassified', () => {
  // Long english prose — should not match base64-blob (has spaces/punctuation)
  const prose = (
    'The quick brown fox jumps over the lazy dog. ' +
    'Phil and Rivet were debugging the embedder for hours. '
  ).repeat(40)
  assert.equal(classifyUnembeddable(prose), null)
})

test('code with reasonable line lengths is NOT misclassified', () => {
  const code = (
    'function foo(bar) {\n' +
    "  return bar.map(x => x.toString()).join(',');\n" +
    '}\n'
  ).repeat(50)
  assert.equal(classifyUnembeddable(code), null)
})

test('"[media attached:" is case-insensitive', () => {
  assert.equal(classifyUnembeddable('[MEDIA ATTACHED: x]'), 'media-marker')
  assert.equal(classifyUnembeddable('[Media Attached: x]'), 'media-marker')
})
