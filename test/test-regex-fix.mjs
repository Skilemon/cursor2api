const oldP = () => /```json(?:\s+action)?/g;
const newP = () => /```json(?:\s+action)?(?=\s|$)/g;
const tests = [
  ['json action block', '```json action\n{"tool":"Read"}\n```', true],
  ['plain json block', '```json\n{"k":"v"}\n```', true],
  ['regex in text', '/```json(?:\\s+action)?/g is the pattern', false],
  ['json followed by (', '```json(?:\\s+acti... not valid', false],
];
let ok = 0, fail = 0;
for (const [name, text, expect] of tests) {
  const got = newP().test(text);
  const pass = got === expect;
  console.log((pass?'PASS':'FAIL'), name, '| old:', oldP().test(text), 'new:', got, 'expect:', expect);
  pass ? ok++ : fail++;
}
console.log('\n' + ok + ' passed, ' + fail + ' failed');
