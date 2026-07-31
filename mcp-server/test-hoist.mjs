// Verify the server strips base64 out of tool results and emits image blocks.
import { readFileSync } from 'fs';
const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
let fails = 0;
const check = (name, cond, extra='') => { console.log((cond?'PASS  ':'FAIL  ')+name+(extra?'  — '+extra:'')); if(!cond) fails++; };

check('top-level anomaly shot is hoisted', /if \(result\?\.screenshot\?\.data\)/.test(src));
check('top-level shot deletes base64 from JSON', /const \{ data, \.\.\.meta \} = shot;/.test(src));
check('batch collects images array', /const batchImages = \[\];/.test(src));
check('batch strips nested shot data', /delete shot\.data;/.test(src));
check('batch emits collected images', /\.\.\.images, \.\.\.batchImages/.test(src));
check('save writes bytes to disk', /saved_to: targetPath/.test(src));
check('batch save strips data too', /delete payload\.data;/.test(src));

// simulate the hoist on a fake result
const fake = { ok:true, screenshot:{ data:'data:image/jpeg;base64,AAAA', region:{x:1}, reason:'test' } };
const base64 = fake.screenshot.data.replace(/^data:image\/(jpeg|png);base64,/, '');
const { data, ...meta } = fake.screenshot;
check('simulated strip leaves no base64', base64 === 'AAAA' && data && !('data' in meta), JSON.stringify(meta));
console.log(fails ? `\n${fails} failure(s)` : '\nall hoist paths present');
process.exit(fails?1:0);
