const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'autotrade-sec-'));
require('ts-node/register');
const research = require('../src/collect/research');

test('SEC filing text drops XBRL tags and the hidden header before the form title', () => {
  const html = '<html><body><ix:header><xbrli:context id="c1"><xbrli:identifier>0000320193</xbrli:identifier></xbrli:context></ix:header>' +
    '<p>UNITED STATES</p><p>SECURITIES AND EXCHANGE COMMISSION</p><p>FORM 10-K</p>' +
    '<p>Revenue was <ix:nonFraction name="us-gaap:Revenues">416,161</ix:nonFraction> million &#8212; Apple&#8217;s</p></body></html>';
  const text = research.secNarrative(research.sourcePlainText(research.stripXbrlMarkup(html)));
  assert.match(text, /^UNITED STATES\s+SECURITIES AND EXCHANGE COMMISSION/);
  assert.ok(!text.includes('0000320193'));
  assert.ok(text.includes('Revenue was 416,161 million — Apple’s'));
});

test('secNarrative leaves text without a form title unchanged', () => {
  assert.equal(research.secNarrative('Press release: results'), 'Press release: results');
});
